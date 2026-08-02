import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";

type Bang = { d: string; ad?: string; s: string; u: string; ts?: string[] };
const rawBangs: Bang[] = JSON.parse(readFileSync("src/bangs/bangs.json", "utf-8"));

// Load custom bangs
let customBangs: Bang[] = [];
try {
	const customData = JSON.parse(readFileSync("src/bangs/custom-bangs.json", "utf-8"));
	if (Array.isArray(customData)) customBangs = customData;
} catch {}

// Merge: custom overrides upstream
const allBangs: Bang[] = [...rawBangs];
for (const cb of customBangs) {
	for (let i = allBangs.length - 1; i >= 0; i--) {
		if (allBangs[i].t === cb.t || (cb.ts && cb.ts.includes(allBangs[i].t!))) {
			allBangs.splice(i, 1);
		}
	}
	allBangs.push(cb);
}

// Expand aliases
const entries: [string, Bang][] = [];
for (const bang of allBangs) {
	if (!bang.t || !bang.u || !bang.s || !bang.d) continue;
	entries.push([bang.t, bang]);
	if (bang.ts) for (const alias of bang.ts) entries.push([alias, bang]);
}
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const n = entries.length;

// Suggestion ranking. Kagi publishes no popularity data, so we join
// DuckDuckGo's usage counts by trigger name (see fetch-ranks.ts). Counts are
// heavy-tailed, so we log-quantize into a single byte per entry: that keeps
// ~99.9% of the ordering while costing ~13 KiB instead of ~53 KiB.
let ddgRanks: Record<string, number> = {};
try {
	ddgRanks = JSON.parse(readFileSync("src/bangs/ddg-ranks.json", "utf-8"));
} catch {
	console.warn("  (no ddg-ranks.json; suggestions will be unranked)");
}

const rawRanks = entries.map(([t]) => ddgRanks[t] ?? 0);
const maxRank = Math.max(1, ...rawRanks);
const logMax = Math.log2(maxRank + 1);
const rankBytes = new Uint8Array(n);
for (let i = 0; i < n; i++) {
	rankBytes[i] = rawRanks[i] === 0
		? 0
		: Math.min(255, Math.round((Math.log2(rawRanks[i] + 1) / logMax) * 255));
}
const rankedCount = rawRanks.filter((r) => r > 0).length;

// Suggestion data for the Cloudflare Pages Function (see functions/suggest.ts).
//
// Address-bar suggestions cannot be served from the client. Chromium fetches
// them from the browser process via SimpleURLLoader, straight to the network
// stack, so the request has no client and no Service Worker ever sees a fetch
// event for it (crbug 41389229). Firefox's urlbar does the same from the parent
// process. So this one feature has to run on a server.
//
// It only needs triggers and their popularity, never URLs, so it ships as its
// own small module rather than reusing bangs.bin. Embedding it in the function
// bundle keeps the lookup free of I/O: no KV read, no asset fetch, nothing to
// wait on before answering.
//
// Triggers are newline-joined in the same sort order used above, which lets the
// function binary search the split array directly. No trigger contains a
// newline, so the join is unambiguous.
const suggestTriggers = entries.map(([t]) => t);
if (suggestTriggers.some((t) => t.includes("\n"))) {
	console.error("trigger contains a newline; suggest encoding would break");
	process.exit(1);
}

// Rich suggestions also need the service name and domain for each entry, to
// build the description and favicon the browser shows in the dropdown. Many
// entries share one service, so the strings are interned and each entry just
// carries two small indices. Both lists are also newline-joined: neither a
// service name nor a domain can contain a newline, so the joins stay
// unambiguous.
const serviceIndex = new Map<string, number>();
const domainIndex = new Map<string, number>();
const serviceNames: string[] = [];
const domains: string[] = [];
const entryService: number[] = [];
const entryDomain: number[] = [];
for (const [, bang] of entries) {
	let si = serviceIndex.get(bang.s);
	if (si === undefined) {
		si = serviceNames.length;
		serviceIndex.set(bang.s, si);
		serviceNames.push(bang.s);
	}
	entryService.push(si);

	// The dropdown shows the domain next to the name, so strip the leading
	// "www." here rather than pay for it in every string and strip it at runtime.
	const domain = bang.d.replace(/^www\./, "");
	let di = domainIndex.get(domain);
	if (di === undefined) {
		di = domains.length;
		domainIndex.set(domain, di);
		domains.push(domain);
	}
	entryDomain.push(di);
}

// Indices are packed as little-endian u16 and base64'd like the rank bytes.
function packU16(values: number[]): string {
	const bytes = new Uint8Array(values.length * 2);
	for (let i = 0; i < values.length; i++) {
		bytes[i * 2] = values[i] & 0xff;
		bytes[i * 2 + 1] = (values[i] >> 8) & 0xff;
	}
	return Buffer.from(bytes).toString("base64");
}

// Per-bang suggestion endpoints (resolve-suggestions.ts). When a bang is
// followed by a space, the rest of the query is forwarded to that service's
// own autocomplete API. The map is interned like the description fields: most
// triggers share an endpoint (every wiki alias, every google-backed engine),
// so each trigger just carries the endpoint index and a shape byte that says
// how to read the payload. 255 means "no suggestion endpoint for this bang".
type SuggestEndpoint = { url: string; shape: string };
let suggestEndpoints: Record<string, SuggestEndpoint> = {};
try {
	suggestEndpoints = JSON.parse(
		readFileSync("src/bangs/suggest-endpoints.json", "utf-8"),
	);
} catch {
	console.warn("  (no suggest-endpoints.json; bangs will not forward)");
}

const endpointIndex = new Map<string, number>();
const endpointUrls: string[] = [];
const endpointShapes: string[] = [];
// Shape names are interned too: only a handful exist, so a byte per endpoint
// beats repeating the strings.
const shapeIndex = new Map<string, number>();
// Per-endpoint shape index, so the function can read a payload the right way
// without re-deriving it from the URL.
const endpointShapeIdx: number[] = [];
// 255 unique endpoints already, so u8 would collide with the "none" sentinel;
// u16 leaves room to grow. 65535 means "no suggestion endpoint for this bang".
const ENDPOINT_NONE = 65535;
const entryEndpoint: number[] = new Array(n).fill(ENDPOINT_NONE);
for (let i = 0; i < n; i++) {
	const ep = suggestEndpoints[entries[i][0]];
	if (!ep) continue;
	let eidx = endpointIndex.get(ep.url);
	if (eidx === undefined) {
		eidx = endpointUrls.length;
		endpointIndex.set(ep.url, eidx);
		endpointUrls.push(ep.url);
		let sidx = shapeIndex.get(ep.shape);
		if (sidx === undefined) {
			sidx = endpointShapes.length;
			shapeIndex.set(ep.shape, sidx);
			endpointShapes.push(ep.shape);
		}
		endpointShapeIdx[eidx] = sidx;
	}
	entryEndpoint[i] = eidx;
}

writeFileSync(
	"src/bangs/suggest-data.ts",
	`// Generated by packbang.ts. Do not edit.\n` +
		`// ${n} triggers, newline-joined in sort order, with one log-quantized\n` +
		`// popularity byte each (base64). SERVICE_NAMES and DOMAINS are the\n` +
		`// interned description fields; ENTRY_* map each trigger to them as\n` +
		`// little-endian u16 (base64). ENDPOINT_URLS / ENDPOINT_SHAPES are the\n` +
		`// per-bang suggestion APIs; ENTRY_ENDPOINT maps each trigger to an\n` +
		`// endpoint index as little-endian u16 (65535 = none).\n` +
		`export const TRIGGERS = ${JSON.stringify(suggestTriggers.join("\n"))};\n` +
		`export const RANKS_B64 = ${JSON.stringify(Buffer.from(rankBytes).toString("base64"))};\n` +
		`export const SERVICE_NAMES = ${JSON.stringify(serviceNames.join("\n"))};\n` +
		`export const DOMAINS = ${JSON.stringify(domains.join("\n"))};\n` +
		`export const ENTRY_SERVICE_B64 = ${JSON.stringify(packU16(entryService))};\n` +
		`export const ENTRY_DOMAIN_B64 = ${JSON.stringify(packU16(entryDomain))};\n` +
		`export const ENDPOINT_URLS = ${JSON.stringify(endpointUrls.join("\n"))};\n` +
		`export const ENDPOINT_SHAPES = ${JSON.stringify(endpointShapes.join("\n"))};\n` +
		`export const ENDPOINT_SHAPE_IDX_B64 = ${JSON.stringify(Buffer.from(new Uint8Array(endpointShapeIdx)).toString("base64"))};\n` +
		`export const ENTRY_ENDPOINT_B64 = ${JSON.stringify(packU16(entryEndpoint))};\n`,
);

function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	const bytes = new TextEncoder().encode(str);
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

const hashes = entries.map(([t]) => fnv1a(t));
const hashSet = new Set<number>();
for (const h of hashes) {
	if (hashSet.has(h)) { console.error(`COLLISION: ${h}`); process.exit(1); }
	hashSet.add(h);
}

// CHD minimal perfect hash (Botelho, Pagh, Ziviani 2007).
//
// Each displacement mixes the bucket's hashes through a lowbias32 finalizer
// so consecutive attempts scatter entries to uncorrelated positions. Linear
// probing ((hash + d) % n) shifts every entry by one slot per attempt, which
// degenerates on large buckets; secondary hashing keeps placement attempts
// independent and converges in O(n) total work.
const SLOT_MIX_A = 0x21f0aaad;
const SLOT_MIX_B = 0x735a2d97;
const GOLDEN = 0x9e3779b9;

function mphSlot(hash: number, displacement: number, size: number): number {
	let x = (hash + Math.imul(displacement + 1, GOLDEN)) >>> 0;
	x ^= x >>> 16;
	x = Math.imul(x, SLOT_MIX_A) >>> 0;
	x ^= x >>> 15;
	x = Math.imul(x, SLOT_MIX_B) >>> 0;
	x ^= x >>> 15;
	return (x >>> 0) % size;
}

function nextPow2(v: number): number {
	v--;
	v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
	return v + 1;
}

function buildMPHF(n: number, hashes: Uint32Array) {
	const bucketCount = nextPow2(Math.max(2, Math.ceil(n / 4)));
	const bucketMask = bucketCount - 1;

	const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
	for (let i = 0; i < n; i++) buckets[hashes[i] & bucketMask].push(i);

	// Largest buckets are hardest to place; try them first.
	const heavy = buckets
		.map((members, id) => ({ members, id }))
		.filter((b) => b.members.length > 1)
		.sort((a, b) => b.members.length - a.members.length);

	const placed = new Uint8Array(n);
	const slotToEntry = new Uint16Array(n);
	const displacements = new Int32Array(bucketCount).fill(-1);

	// Generation counter avoids allocating a Set per attempt.
	const seenStamp = new Uint32Array(n);
	let generation = 0;
	let maxDisplacement = 0;

	for (const { members, id } of heavy) {
		let d = 0;
		for (;; d++) {
			generation++;
			let fits = true;
			for (const entry of members) {
				const s = mphSlot(hashes[entry], d, n);
				if (placed[s] || seenStamp[s] === generation) { fits = false; break; }
				seenStamp[s] = generation;
			}
			if (fits) break;
			if (d > 1_000_000) throw new Error(`MPHF bucket ${id} unplaceable`);
		}
		displacements[id] = d;
		if (d > maxDisplacement) maxDisplacement = d;
		for (const entry of members) {
			const s = mphSlot(hashes[entry], d, n);
			placed[s] = 1;
			slotToEntry[s] = entry;
		}
	}

	// Singleton buckets take whatever slots remain.
	const remaining: number[] = [];
	for (let s = 0; s < n; s++) if (!placed[s]) remaining.push(s);
	let ri = 0;
	for (let bid = 0; bid < bucketCount; bid++) {
		if (buckets[bid].length !== 1) continue;
		const s = remaining[ri++];
		displacements[bid] = -(s + 1);
		slotToEntry[s] = buckets[bid][0];
	}

	// Fixed-width Int32 displacements: the readers can't reconstruct
	// maxDisplacement to pick a width, so the format commits to one.
	return { displacements, slotToEntry, bucketCount, maxDisplacement };
}

const { displacements, slotToEntry, bucketCount, maxDisplacement } = buildMPHF(n, new Uint32Array(hashes));

// Split and intern templates
function splitTemplate(url: string): [string, string | null] {
	const idx = url.indexOf("{{{s}}}");
	return idx === -1 ? [url, null] : [url.substring(0, idx), url.substring(idx + 7)];
}

const prefixMap = new Map<string, number>();
const suffixMap = new Map<string, number>();
const prefixes: string[] = [];
const suffixes: string[] = [];
const entryPids: number[] = [];
const entrySids: number[] = [];
const enc = new TextEncoder();

for (const [, bang] of entries) {
	const [prefix, suffix] = splitTemplate(bang.u);
	let pid = prefixMap.get(prefix);
	if (pid === undefined) { pid = prefixes.length; prefixMap.set(prefix, pid); prefixes.push(prefix); }
	entryPids.push(pid);
	let sid = -1;
	if (suffix !== null) {
		sid = suffixMap.get(suffix);
		if (sid === undefined) { sid = suffixes.length; suffixMap.set(suffix, sid); suffixes.push(suffix); }
	}
	entrySids.push(sid);
}

// --- v7 binary layout -------------------------------------------------------
//
// v5 stored a slotToEntry permutation, a per-entry prefix index (pid) into an
// interned prefix table, and u32 absolute offset arrays for every blob. v6/v7
// remove all of that overhead, because brotli — not the container — is where
// transfer size is decided:
//
//   * Data is written in MPHF *slot* order, so the slot a lookup computes is
//     itself the entry index. That drops the slotToEntry array entirely.
//   * Prefixes are inlined per entry instead of interned behind a pid array.
//     There are almost as many distinct prefixes as entries, so interning
//     barely dedups; brotli already collapses the shared URL substrings, and
//     dropping the pid indirection is a net win over the wire.
//   * Blob boundaries ship as varint length streams, not u32 offset tables.
//     The reader prefix-sums them into offset arrays once at load, keeping O(1)
//     lookups while the wire carries tiny, highly-repetitive lengths.
//   * The rank byte per entry is gone: only the edge suggestion function reads
//     ranks, and it gets them from suggest-data.ts, never from bangs.bin. v5
//     shipped ~13 KiB of ranks to every client that never touched them.
//
// v7's one change over v6: the full trigger strings (~44 KiB brotli, ~20% of
// the file) are replaced by a 2-byte checksum per entry. The client never
// enumerates triggers — the strings existed only to verify that a lookup landed
// on the right entry. The checksum is the high 16 bits of the same fnv1a hash
// the client already computes for the lookup (the low 13 feed the bucket, so
// the high half is effectively independent), making verification free. The cost
// is probabilistic: a *non-existent* bang (a typo, or a bang from another tool)
// has a 1-in-65,536 chance of matching an occupied slot's checksum and thus
// redirecting somewhere instead of falling through to the default engine. Real
// bangs always resolve correctly.
//
// Suffixes stay interned (they are few and heavily shared) but their offset
// table also becomes a varint length stream.

// LEB128 unsigned varint. Lengths are small and repetitive, so this is both
// compact on the wire and trivial to decode sequentially at load time.
function varint(values: number[]): Uint8Array {
	const out: number[] = [];
	for (let v of values) {
		while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
		out.push(v);
	}
	return Uint8Array.from(out);
}

// Per-entry data, reordered into slot order so the MPHF slot doubles as the
// entry index and no permutation array is needed.
const slotChecksum = new Uint16Array(n);
const slotPrefix: Uint8Array[] = new Array(n);
const slotSid = new Uint16Array(n); // 0xffff = no suffix
const SID_NONE = 0xffff;
for (let slot = 0; slot < n; slot++) {
	const e = slotToEntry[slot];
	slotChecksum[slot] = (hashes[e] >>> 16) & 0xffff;
	slotPrefix[slot] = enc.encode(prefixes[entryPids[e]]);
	slotSid[slot] = entrySids[e] < 0 ? SID_NONE : entrySids[e];
}

const suffixBytes = suffixes.map((s) => enc.encode(s));

const preLenBytes = varint(slotPrefix.map((b) => b.length));
const sufLenBytes = varint(suffixBytes.map((b) => b.length));
const preBlobLen = slotPrefix.reduce((a, b) => a + b.length, 0);
const sufBlobLen = suffixBytes.reduce((a, b) => a + b.length, 0);

const MAGIC = 0x554e4455;
const VERSION = 9;
const dispBytes = displacements.BYTES_PER_ELEMENT * bucketCount;
const headerBytes = 20; // MAGIC, VERSION, n, bucketCount, suffixes.length

const total =
	headerBytes + dispBytes +
	2 * n +
	preLenBytes.byteLength + preBlobLen +
	2 * n +
	sufLenBytes.byteLength + sufBlobLen;

const flat = new Uint8Array(total);
{
	let p = 0;
	const w32 = (v: number) => { flat[p++]=v&0xff; flat[p++]=(v>>8)&0xff; flat[p++]=(v>>16)&0xff; flat[p++]=(v>>24)&0xff; };
	const w16arr = (a: Uint16Array) => { for (let i = 0; i < a.length; i++) { flat[p++] = a[i] & 0xff; flat[p++] = (a[i] >> 8) & 0xff; } };
	const blob = (parts: Uint8Array[]) => { for (const part of parts) { flat.set(part, p); p += part.length; } };
	w32(MAGIC); w32(VERSION); w32(n); w32(bucketCount); w32(suffixes.length);
	flat.set(new Uint8Array(displacements.buffer, displacements.byteOffset, dispBytes), p); p += dispBytes;
	w16arr(slotChecksum);
	flat.set(preLenBytes, p); p += preLenBytes.byteLength;
	blob(slotPrefix);
	w16arr(slotSid);
	flat.set(sufLenBytes, p); p += sufLenBytes.byteLength;
	blob(suffixBytes);
}

writeFileSync("public/bangs.bin", flat);

// Content hash of the data itself. The service worker keys its cache on this,
// so a rebuild invalidates client caches exactly when the bangs change and
// leaves them alone when they don't.
const dataHash = createHash("sha256").update(flat).digest("hex").slice(0, 12);
writeFileSync("src/bangs/data-version.ts", `// Generated by packbang.ts. Do not edit.\nexport const BANG_DATA_VERSION = "${dataHash}";\n`);
console.log(`MPHF v9: ${(total/1024).toFixed(0)} KiB raw`);
console.log(`  Upstream: ${rawBangs.length}, Custom: ${customBangs.length}, Total: ${n}`);
console.log(`  Buckets: ${bucketCount}, max disp: ${maxDisplacement}`);
console.log(`  Prefixes: ${prefixes.length} (inlined), Suffixes: ${suffixes.length} (interned)`);
console.log(`  Ranked for suggestions: ${rankedCount}/${n} (${(rankedCount/n*100).toFixed(1)}%)`);
console.log(`  Data version: ${dataHash}`);
