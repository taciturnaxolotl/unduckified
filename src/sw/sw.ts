// Service Worker: MPHF-based redirect with zero-decode binary artifact.

import { BANG_DATA_VERSION } from "../bangs/data-version.ts";

// Cache name carries the bang data's content hash, so a deploy that changes
// the bangs invalidates client caches automatically, and a deploy that doesn't
// leaves them warm.
const CACHE_NAME = `unduck-${BANG_DATA_VERSION}`;
const CACHE_PREFIX = "unduck-";
// User data lives in its own unversioned cache so bang updates never wipe it.
const USER_CACHE = "unduck-user";
// Caches that must survive a bang data update. Everything else under the
// prefix is a superseded data cache and gets cleaned up on activate.
const PERSISTENT_CACHES = new Set([CACHE_NAME, USER_CACHE]);
const BANGS_BIN = "/bangs.bin";
const CUSTOM_BANGS_KEY = "custom-bangs-cache";
const DB_NAME = "unduck-stats";
const DB_STORE = "counters";
const SEARCH_COUNT_KEY = "search-count";

let loaded = false;
let HEAP: Uint8Array | null = null;
let N = 0;
let BUCKET_COUNT = 0;
let DISP_PTR = 0;
let SLOT_PTR = 0;
let PID_PTR = 0;
let SID_PTR = 0;
let POFF_PTR = 0;
let PBLOB_PTR = 0;
let SOFF_PTR = 0;
let SBLOB_PTR = 0;
let TOFF_PTR = 0;
let TBLOB_PTR = 0;
let RANK_PTR = 0;

// Custom bangs cache: Map<shortcut, {prefix, suffix}>
let customBangsCache = new Map<string, { prefix: string; suffix: string | null }>();

// Search count tracking via IndexedDB
function openStatsDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore(DB_STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function incrementSearchCount(): Promise<void> {
	try {
		const db = await openStatsDB();
		const tx = db.transaction(DB_STORE, "readwrite");
		const store = tx.objectStore(DB_STORE);
		const current = await new Promise<number>((resolve) => {
			const getReq = store.get(SEARCH_COUNT_KEY);
			getReq.onsuccess = () => resolve(getReq.result ?? 0);
			getReq.onerror = () => resolve(0);
		});
		store.put(current + 1, SEARCH_COUNT_KEY);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	} catch {
		// Stats are non-critical, swallow errors
	}
}

async function loadCustomBangs() {
	try {
		const cache = await caches.open(USER_CACHE);
		const resp = await cache.match(CUSTOM_BANGS_KEY);
		if (!resp) return;
		// Data is already in {prefix, suffix} format from message handler
		const data = await resp.json();
		customBangsCache = new Map(Object.entries(data));
	} catch (err) {
		console.warn("Failed to load custom bangs:", err);
	}
}

// Parse the binary header and set up section pointers over the given bytes.
function initBangData(buf: ArrayBuffer) {
	HEAP = new Uint8Array(buf);

	let p = 0;
	const r32 = () => {
		const v = HEAP![p] | (HEAP![p+1]<<8) | (HEAP![p+2]<<16) | (HEAP![p+3]<<24);
		p += 4;
		return v >>> 0;
	};

	const magic = r32();
	const version = r32();
	if (magic !== 0x554e4455 || version !== 5) throw new Error("bad bangs.bin");

	N = r32();
	BUCKET_COUNT = r32();
	const nPrefixes = r32();
	const nSuffixes = r32();

	DISP_PTR = p;
	p += 2 * BUCKET_COUNT; // Int16 displacements
	SLOT_PTR = p;
	p += 2 * N;
	PID_PTR = p;
	p += 2 * N;
	SID_PTR = p;
	p += 2 * N;
	POFF_PTR = p;
	p += 4 * (nPrefixes + 1);
	PBLOB_PTR = p;
	// Skip prefix blob
	const prefixBlobEnd = (() => {
		const base = POFF_PTR + nPrefixes * 4;
		return (HEAP![base] | (HEAP![base+1]<<8) | (HEAP![base+2]<<16) | (HEAP![base+3]<<24)) >>> 0;
	})();
	p += prefixBlobEnd;
	SOFF_PTR = p;
	p += 4 * (nSuffixes + 1);
	SBLOB_PTR = p;
	// Skip suffix blob
	const suffixBlobEnd = (() => {
		const base = SOFF_PTR + nSuffixes * 4;
		return (HEAP![base] | (HEAP![base+1]<<8) | (HEAP![base+2]<<16) | (HEAP![base+3]<<24)) >>> 0;
	})();
	p += suffixBlobEnd;
	TOFF_PTR = p;
	p += 4 * (N + 1);
	TBLOB_PTR = p;
	// Skip trigger blob
	const triggerBlobEnd = (() => {
		const base = TOFF_PTR + N * 4;
		return (HEAP![base] | (HEAP![base+1]<<8) | (HEAP![base+2]<<16) | (HEAP![base+3]<<24)) >>> 0;
	})();
	p += triggerBlobEnd;
	RANK_PTR = p;

	loaded = true;
}

// Adopt bang data handed over by the page. The page-level fallback downloads
// bangs.bin to answer the very first query, so it passes the bytes along
// instead of making the worker fetch the same file a second time.
async function seedBangData(buf: ArrayBuffer) {
	if (loaded) return;
	initBangData(buf);
	await loadCustomBangs();
	// Persist so later worker starts skip the network entirely.
	try {
		const cache = await caches.open(CACHE_NAME);
		await cache.put(BANGS_BIN, new Response(buf.slice(0), {
			headers: { "Content-Type": "application/octet-stream" },
		}));
	} catch {
		// Cache writes are best-effort; the in-memory copy still works.
	}
}

let bangDataPromise: Promise<void> | null = null;

// Load bang data: cache first, network on miss, then populate the cache.
// Never assumes install succeeded, so a failed or skipped precache is
// recoverable instead of wedging the worker permanently.
async function loadBangsUncached() {
	const cache = await caches.open(CACHE_NAME);

	let resp = await cache.match(BANGS_BIN);
	if (!resp) {
		resp = await fetch(BANGS_BIN);
		if (!resp.ok) throw new Error(`bangs.bin fetch failed: ${resp.status}`);
		try {
			await cache.put(BANGS_BIN, resp.clone());
		} catch {
			// Best-effort; proceed with the response we already hold.
		}
	}

	initBangData(await resp.arrayBuffer());
	await loadCustomBangs();
}

function loadBangs(): Promise<void> {
	if (loaded) return Promise.resolve();
	// Share one in-flight load so concurrent navigations don't stampede.
	if (!bangDataPromise) {
		bangDataPromise = loadBangsUncached().catch((err) => {
			bangDataPromise = null; // allow a retry on the next request
			throw err;
		});
	}
	return bangDataPromise;
}

function getDisp(bucketId: number): number {
	const base = DISP_PTR + bucketId * 2;
	const v = HEAP![base] | (HEAP![base+1]<<8);
	return v < 0x8000 ? v : v - 0x10000;
}

function getSlotEntry(slot: number): number {
	const base = SLOT_PTR + slot * 2;
	return HEAP![base] | (HEAP![base+1]<<8);
}

function getPid(entryIdx: number): number {
	const base = PID_PTR + entryIdx * 2;
	return HEAP![base] | (HEAP![base+1]<<8);
}

function getSid(entryIdx: number): number {
	const base = SID_PTR + entryIdx * 2;
	const v = HEAP![base] | (HEAP![base+1]<<8);
	return v < 0x8000 ? v : v - 0x10000;
}

function getPrefixOffset(idx: number): number {
	const base = POFF_PTR + idx * 4;
	return (HEAP![base] | (HEAP![base+1]<<8) | (HEAP![base+2]<<16) | (HEAP![base+3]<<24)) >>> 0;
}

function getSuffixOffset(idx: number): number {
	const base = SOFF_PTR + idx * 4;
	return (HEAP![base] | (HEAP![base+1]<<8) | (HEAP![base+2]<<16) | (HEAP![base+3]<<24)) >>> 0;
}

function getTriggerOffset(idx: number): number {
	const base = TOFF_PTR + idx * 4;
	return (HEAP![base] | (HEAP![base+1]<<8) | (HEAP![base+2]<<16) | (HEAP![base+3]<<24)) >>> 0;
}

function getTrigger(entryIdx: number): string {
	const start = TBLOB_PTR + getTriggerOffset(entryIdx);
	const end = TBLOB_PTR + getTriggerOffset(entryIdx + 1);
	return new TextDecoder().decode(HEAP!.subarray(start, end));
}

// Compare trigger[i] against prefix bytes without decoding the string.
// Returns 0 when the trigger starts with the prefix, <0 when it sorts before.
function cmpTriggerPrefix(i: number, pb: Uint8Array): number {
	const start = TBLOB_PTR + getTriggerOffset(i);
	const len = getTriggerOffset(i + 1) - getTriggerOffset(i);
	for (let j = 0; j < pb.length; j++) {
		if (j >= len) return -1;
		const d = HEAP![start + j] - pb[j];
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

// Triggers are stored sorted, so every prefix match is a contiguous range.
// Binary search for its start (~14 steps over 13.5k entries).
function lowerBound(pb: Uint8Array): number {
	let lo = 0;
	let hi = N;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cmpTriggerPrefix(mid, pb) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

const SUGGEST_LIMIT = 8;

// Compare two candidates by (rank desc, trigger length asc, index asc).
// Index ascending is equivalent to alphabetical, since triggers are sorted.
function candidateBeats(
	aRank: number, aLen: number, aIdx: number,
	bRank: number, bLen: number, bIdx: number,
): boolean {
	if (aRank !== bRank) return aRank > bRank;
	if (aLen !== bLen) return aLen < bLen;
	return aIdx < bIdx;
}

// Prefix suggestions ordered by popularity, then trigger length, then
// alphabetically. Custom bangs always sort first.
//
// A prefix match is a contiguous range (triggers are sorted), but that range
// can be large: "!s" matches ~1000 entries and an empty prefix matches all
// 13.5k. So we keep a bounded top-K list over the raw rank bytes and only
// decode the handful of triggers that actually survive.
function suggestTriggers(prefix: string, limit = SUGGEST_LIMIT): string[] {
	if (!loaded || !HEAP) return [];

	const custom: string[] = [];
	for (const trigger of customBangsCache.keys()) {
		if (trigger.startsWith(prefix)) custom.push(trigger);
	}
	custom.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
	if (custom.length >= limit) return custom.slice(0, limit);

	const slots = limit - custom.length;
	const topIdx: number[] = [];
	const topRank: number[] = [];
	const topLen: number[] = [];

	const pb = new TextEncoder().encode(prefix);
	for (let i = lowerBound(pb); i < N; i++) {
		if (cmpTriggerPrefix(i, pb) !== 0) break;

		const rank = HEAP[RANK_PTR + i];
		const len = getTriggerOffset(i + 1) - getTriggerOffset(i);

		// Skip early if this cannot displace the current worst entry.
		if (topIdx.length === slots) {
			const w = topIdx.length - 1;
			if (!candidateBeats(rank, len, i, topRank[w], topLen[w], topIdx[w])) {
				continue;
			}
		}

		// Insertion sort into the bounded top list.
		let pos = topIdx.length < slots ? topIdx.length : slots - 1;
		topIdx[pos] = i;
		topRank[pos] = rank;
		topLen[pos] = len;
		while (
			pos > 0 &&
			candidateBeats(
				topRank[pos], topLen[pos], topIdx[pos],
				topRank[pos - 1], topLen[pos - 1], topIdx[pos - 1],
			)
		) {
			const ti = topIdx[pos]; topIdx[pos] = topIdx[pos - 1]; topIdx[pos - 1] = ti;
			const tr = topRank[pos]; topRank[pos] = topRank[pos - 1]; topRank[pos - 1] = tr;
			const tl = topLen[pos]; topLen[pos] = topLen[pos - 1]; topLen[pos - 1] = tl;
			pos--;
		}
	}

	const out = custom;
	for (const i of topIdx) {
		const trigger = getTrigger(i);
		if (customBangsCache.has(trigger)) continue; // already listed above
		out.push(trigger);
	}
	return out.slice(0, limit);
}

function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	const bytes = new TextEncoder().encode(str);
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function resolveCustom(trigger: string, query: string): string | null {
	const entry = customBangsCache.get(trigger);
	if (!entry) return null;
	return entry.prefix + encodeURIComponent(query) + (entry.suffix || "");
}

// MPHF lookup with trigger verification. Returns the entry index, or null if
// the trigger is not actually present (guards against hash collisions / misses).
function lookupEntry(trigger: string): number | null {
	if (!loaded || !HEAP) return null;

	const hash = fnv1a(trigger);
	const bucketId = hash & (BUCKET_COUNT - 1);
	const displacement = getDisp(bucketId);

	let entryIdx: number;
	if (displacement >= 0) {
		entryIdx = getSlotEntry((hash + displacement) % N);
	} else {
		entryIdx = getSlotEntry(-(displacement + 1));
	}

	if (getTrigger(entryIdx) !== trigger) return null;
	return entryIdx;
}

function bangExists(trigger: string): boolean {
	if (customBangsCache.has(trigger)) return true;
	return lookupEntry(trigger) !== null;
}

function resolve(trigger: string, query: string): string | null {
	if (!loaded || !HEAP) return null;

	// Check custom bangs first (user overrides take priority)
	const customResult = resolveCustom(trigger, query);
	if (customResult) return customResult;

	const entryIdx = lookupEntry(trigger);
	if (entryIdx === null) return null;

	const pid = getPid(entryIdx);
	const sid = getSid(entryIdx);

	// Build URL: prefix + encoded query + suffix
	const pStart = PBLOB_PTR + getPrefixOffset(pid);
	const pEnd = PBLOB_PTR + getPrefixOffset(pid + 1);
	let url = new TextDecoder().decode(HEAP!.subarray(pStart, pEnd));
	url += encodeURIComponent(query);

	if (sid >= 0) {
		const sStart = SBLOB_PTR + getSuffixOffset(sid);
		const sEnd = SBLOB_PTR + getSuffixOffset(sid + 1);
		url += new TextDecoder().decode(HEAP!.subarray(sStart, sEnd));
	}

	return url;
}

self.addEventListener("install", () => {
	// Activate immediately and download nothing here. Bang data arrives either
	// from the page (which already fetched it to answer the first query) or
	// lazily on demand, so installation never stalls on a 700+ KiB transfer.
	self.skipWaiting();
});

self.addEventListener("message", async (event) => {
	if (event.data?.type === "SEED_BANG_DATA" && event.data.buffer) {
		try {
			await seedBangData(event.data.buffer as ArrayBuffer);
		} catch {
			// Bad payload: fall back to loading it ourselves on next use.
		}
	}

	if (event.data?.type === "UPDATE_CUSTOM_BANGS") {
		const bangs = event.data.bangs;
		// Convert {shortcut: {u: "https://example.com?q={{{s}}}"}} to Map<shortcut, {prefix, suffix}>
		const processedBangs: Record<string, { prefix: string; suffix: string | null }> = {};
		for (const [shortcut, bang] of Object.entries(bangs)) {
			const url = (bang as any).u;
			const idx = url.indexOf("{{{s}}}");
			const prefix = idx === -1 ? url : url.substring(0, idx);
			const suffix = idx === -1 ? null : url.substring(idx + 7);
			processedBangs[shortcut] = { prefix, suffix };
		}
		customBangsCache = new Map(Object.entries(processedBangs));
		// Persist to Cache API for SW restarts
		caches.open(USER_CACHE).then((cache) => {
			const response = new Response(JSON.stringify(processedBangs), {
				headers: { "Content-Type": "application/json" },
			});
			cache.put(CUSTOM_BANGS_KEY, response);
		});
	}

	if (event.data?.type === "HAS_BANG_DATA") {
		const port = event.ports?.[0];
		const reply = (ready: boolean) => {
			const msg = { type: "BANG_DATA_STATUS", ready };
			if (port) port.postMessage(msg);
			else event.source?.postMessage(msg);
		};
		if (loaded) {
			reply(true);
		} else {
			// Not parsed yet, but a cached copy still means no download is needed.
			try {
				const cache = await caches.open(CACHE_NAME);
				reply(Boolean(await cache.match(BANGS_BIN)));
			} catch {
				reply(false);
			}
		}
	}

	if (event.data?.type === "CHECK_BANG_EXISTS") {
		const port = event.ports?.[0];
		const trigger = String(event.data.trigger ?? "").toLowerCase();
		const reply = (exists: boolean) => {
			const msg = { type: "BANG_EXISTS", trigger, exists };
			if (port) port.postMessage(msg);
			else event.source?.postMessage(msg);
		};
		try {
			await loadBangs();
			reply(bangExists(trigger));
		} catch {
			reply(false);
		}
	}

	if (event.data?.type === "GET_SEARCH_COUNT") {
		const port = event.ports?.[0];
		const reply = (count: number) => {
			if (port) {
				port.postMessage({ type: "SEARCH_COUNT", count });
			} else {
				event.source?.postMessage({ type: "SEARCH_COUNT", count });
			}
		};
		try {
			const db = await openStatsDB();
			const tx = db.transaction(DB_STORE, "readonly");
			const store = tx.objectStore(DB_STORE);
			const count = await new Promise<number>((resolve) => {
				const req = store.get(SEARCH_COUNT_KEY);
				req.onsuccess = () => resolve(req.result ?? 0);
				req.onerror = () => resolve(0);
			});
			db.close();
			reply(count);
		} catch {
			reply(0);
		}
	}
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// Drop bang data from earlier deploys; keep the current one and all
			// user data.
			const names = await caches.keys();
			await Promise.all(
				names
					.filter(
						(name) =>
							name.startsWith(CACHE_PREFIX) && !PERSISTENT_CACHES.has(name),
					)
					.map((name) => caches.delete(name)),
			);
			await self.clients.claim();
		})(),
	);
});

// Parse a partial bang out of a suggestion query. Handles a leading bang
// ("!git", "!g cats") and a trailing one ("cats !git"), mirroring how the
// redirect handler accepts both orders.
function parsePartialBang(
	query: string,
): { prefix: string; partial: string } | null {
	const leading = query.match(/^!(\S*)$/);
	if (leading) return { prefix: "", partial: leading[1].toLowerCase() };

	const trailing = query.match(/^(.*\s)!(\S*)$/);
	if (trailing) return { prefix: trailing[1], partial: trailing[2].toLowerCase() };

	return null;
}

const OPENSEARCH_JSON_HEADERS = {
	"Content-Type": "application/x-suggestions+json",
	"Cache-Control": "no-store",
};

function suggestionsResponse(query: string, completions: string[]): Response {
	// OpenSearch suggestion format: [query, [completions], [descriptions], [urls]]
	return new Response(JSON.stringify([query, completions, [], []]), {
		headers: OPENSEARCH_JSON_HEADERS,
	});
}

async function handleSuggest(url: URL): Promise<Response> {
	const query = url.searchParams.get("q") ?? "";
	const bang = parsePartialBang(query.trim());
	if (!bang) return suggestionsResponse(query, []);

	try {
		await loadBangs();
	} catch {
		return suggestionsResponse(query, []);
	}

	const completions = suggestTriggers(bang.partial).map(
		(trigger) => `${bang.prefix}!${trigger}`,
	);
	return suggestionsResponse(query, completions);
}

self.addEventListener("fetch", (event: FetchEvent) => {
	const url = new URL(event.request.url);

	// Address-bar suggestions (OpenSearch). Served locally so the query never
	// leaves the device.
	if (url.pathname === "/suggest" && url.origin === self.location.origin) {
		event.respondWith(handleSuggest(url));
		return;
	}

	if (event.request.mode !== "navigate") return;

	const q = url.searchParams.get("q");
	if (!q || q.trim() === "") return;

	const trimmed = q.trim();
	const match = trimmed.match(/^!(\S+)/i) || trimmed.match(/(\S+)!$/i);
	const bangTrigger = match ? match[1].toLowerCase() : null;
	const cleanQuery = bangTrigger
		? trimmed.replace(/^!\S+\s*|\S+!$/i, "").trim()
		: trimmed;

	event.respondWith(
		(async () => {
			await loadBangs();
			if (bangTrigger) {
				const dest = resolve(bangTrigger, cleanQuery);
				if (dest) {
					// Track search count in the background
					incrementSearchCount();
					return Response.redirect(dest, 302);
				}
			}
			return fetch(event.request);
		})(),
	);
});
