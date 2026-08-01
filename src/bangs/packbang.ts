import { readFileSync, writeFileSync } from "fs";

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

// Bucketed MPHF with adjustable load factor
function buildMPHF(n: number, hashes: Uint32Array, maxAttempts = 3) {
	for (let lf = 3; lf <= 6; lf += 0.5) {
		const bucketCount = (() => {
			let v = Math.max(2, Math.ceil(n / lf));
			v--; v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16; v++;
			return v;
		})();
		const bucketMask = bucketCount - 1;
		
		const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
		for (let i = 0; i < n; i++) buckets[hashes[i] & bucketMask].push(i);

		const orderedBuckets = buckets
			.map((entries, id) => ({ entries, id }))
			.filter((b) => b.entries.length > 1)
			.sort((a, b) => b.entries.length - a.entries.length || a.id - b.id);

		const occupied = new Uint8Array(n);
		const slotToEntry = new Uint16Array(n);
		const wideDisplacements = new Int32Array(bucketCount);
		wideDisplacements.fill(-1);
		let maxDisplacement = 0;
		let failed = false;

		for (const bucket of orderedBuckets) {
			let displacement = 0;
			for (; displacement <= 100_000; displacement++) {
				let ok = true;
				const seen = new Set<number>();
				for (const entry of bucket.entries) {
					const slot = (hashes[entry] + displacement) % n;
					if (occupied[slot] || seen.has(slot)) { ok = false; break; }
					seen.add(slot);
				}
				if (ok) break;
			}
			if (displacement > 100_000) { failed = true; break; }
			wideDisplacements[bucket.id] = displacement;
			maxDisplacement = Math.max(maxDisplacement, displacement);
			for (const entry of bucket.entries) {
				const slot = (hashes[entry] + displacement) % n;
				occupied[slot] = 1;
				slotToEntry[slot] = entry;
			}
		}

		if (failed) continue;

		// Place singletons
		const freeSlots: number[] = [];
		for (let s = 0; s < n; s++) if (!occupied[s]) freeSlots.push(s);
		let fi = 0;
		for (let bid = 0; bid < bucketCount; bid++) {
			if (buckets[bid].length !== 1) continue;
			const slot = freeSlots[fi++];
			wideDisplacements[bid] = -(slot + 1);
			slotToEntry[slot] = buckets[bid][0];
		}

		const displacements = n <= 0x7fff && maxDisplacement <= 0x7fff
			? Int16Array.from(wideDisplacements) : wideDisplacements;
		
		return { displacements, slotToEntry, bucketCount, maxDisplacement };
	}
	throw new Error("MPHF construction failed for all load factors");
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

function packBlobOffsets(strings: string[]): { offsets: Uint32Array; blob: Uint8Array } {
	const parts = strings.map(s => enc.encode(s));
	const offsets = new Uint32Array(parts.length + 1);
	const total = parts.reduce((a, p, i) => { offsets[i] = a; return a + p.length; }, 0);
	offsets[parts.length] = total;
	const blob = new Uint8Array(total);
	let p = 0;
	for (const part of parts) { blob.set(part, p); p += part.length; }
	return { offsets, blob };
}

const prefixData = packBlobOffsets(prefixes);
const suffixData = packBlobOffsets(suffixes);

// Pack trigger strings in entry order for verification / existence checks
const triggerData = packBlobOffsets(entries.map(([t]) => t));

const MAGIC = 0x554e4455;
const VERSION = 5;
const dispBytes = displacements.BYTES_PER_ELEMENT * bucketCount;
const headerBytes = 24;

const total =
	headerBytes + dispBytes + 2*n + 2*n + 2*n +
	4*(prefixes.length+1) + prefixData.blob.byteLength +
	4*(suffixes.length+1) + suffixData.blob.byteLength +
	4*(n+1) + triggerData.blob.byteLength +
	n;

const flat = new Uint8Array(total);
{
	let p = 0;
	const w32 = (v: number) => { flat[p++]=v&0xff; flat[p++]=(v>>8)&0xff; flat[p++]=(v>>16)&0xff; flat[p++]=(v>>24)&0xff; };
	w32(MAGIC); w32(VERSION); w32(n); w32(bucketCount); w32(prefixes.length); w32(suffixes.length);
	flat.set(new Uint8Array(displacements.buffer), p); p += dispBytes;
	flat.set(new Uint8Array(slotToEntry.buffer), p); p += 2*n;
	for(let i=0;i<n;i++){flat[p++]=entryPids[i]&0xff;flat[p++]=(entryPids[i]>>8)&0xff;}
	for(let i=0;i<n;i++){const v=entrySids[i];flat[p++]=v&0xff;flat[p++]=(v>>8)&0xff;}
	flat.set(new Uint8Array(prefixData.offsets.buffer), p); p += 4*(prefixes.length+1);
	flat.set(prefixData.blob, p); p += prefixData.blob.byteLength;
	flat.set(new Uint8Array(suffixData.offsets.buffer), p); p += 4*(suffixes.length+1);
	flat.set(suffixData.blob, p); p += suffixData.blob.byteLength;
	flat.set(new Uint8Array(triggerData.offsets.buffer), p); p += 4*(n+1);
	flat.set(triggerData.blob, p); p += triggerData.blob.byteLength;
	flat.set(rankBytes, p);
}

writeFileSync("public/bangs.bin", flat);
console.log(`MPHF v5: ${(total/1024).toFixed(0)} KiB raw`);
console.log(`  Upstream: ${rawBangs.length}, Custom: ${customBangs.length}, Total: ${n}`);
console.log(`  Buckets: ${bucketCount}, max disp: ${maxDisplacement}`);
console.log(`  Prefixes: ${prefixes.length}, Suffixes: ${suffixes.length}`);
console.log(`  Ranked for suggestions: ${rankedCount}/${n} (${(rankedCount/n*100).toFixed(1)}%)`);
