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
// Set once the legacy localStorage search count has been folded in, so the
// one-time migration can never double-count across reloads or multiple tabs.
const LS_MIGRATED_KEY = "ls-search-count-migrated";

let loaded = false;
let HEAP: Uint8Array | null = null;
let N = 0;
let BUCKET_COUNT = 0;
let DISP_PTR = 0;
let CHK_PTR = 0;
let SID_PTR = 0;
let PBLOB_PTR = 0;
let SBLOB_PTR = 0;
// Offset tables reconstructed at load from the wire's varint length streams.
// Entry order is MPHF-slot order, so an entry index is also its slot.
let POFF: Uint32Array | null = null;
let SOFF: Uint32Array | null = null;
const SID_NONE = 0xffff;

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

async function incrementSearchCount(key: string = SEARCH_COUNT_KEY): Promise<void> {
	try {
		const db = await openStatsDB();
		const tx = db.transaction(DB_STORE, "readwrite");
		const store = tx.objectStore(DB_STORE);
		const current = await new Promise<number>((resolve) => {
			const getReq = store.get(key);
			getReq.onsuccess = () => resolve(getReq.result ?? 0);
			getReq.onerror = () => resolve(0);
		});
		store.put(current + 1, key);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	} catch {
		// Stats are non-critical, swallow errors
	}
}

const DEFAULT_BANG_KEY = "default-bang";
let defaultBang = "ddg";

async function loadDefaultBang() {
	try {
		const cache = await caches.open(USER_CACHE);
		const resp = await cache.match(DEFAULT_BANG_KEY);
		if (resp) defaultBang = (await resp.text()) || "ddg";
	} catch {
		// Keep the built-in default.
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
	if (magic !== 0x554e4455 || version !== 8) throw new Error("bad bangs.bin");

	N = r32();
	BUCKET_COUNT = r32();
	const nSuffixes = r32();

	// Read `count` LEB128 varint lengths and prefix-sum them into an offset
	// table of size count+1, advancing p past the varint stream.
	const readOffsets = (count: number): Uint32Array => {
		const offsets = new Uint32Array(count + 1);
		let acc = 0;
		for (let i = 0; i < count; i++) {
			let v = 0, shift = 0, b: number;
			do { b = HEAP![p++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
			offsets[i] = acc;
			acc += v >>> 0;
		}
		offsets[count] = acc;
		return offsets;
	};

	DISP_PTR = p;
	p += 2 * BUCKET_COUNT; // Int16 displacements
	CHK_PTR = p;
	p += 2 * N; // u16 verification checksum per entry
	POFF = readOffsets(N);
	PBLOB_PTR = p;
	p += POFF[N];
	SID_PTR = p;
	p += 2 * N; // u16 suffix index per entry (0xffff = none)
	SOFF = readOffsets(nSuffixes);
	SBLOB_PTR = p;
	// Nothing reads past the suffix blob.

	loaded = true;
}

// Adopt bang data handed over by the page. The page-level fallback downloads
// bangs.bin to answer the very first query, so it passes the bytes along
// instead of making the worker fetch the same file a second time.
async function seedBangData(buf: ArrayBuffer) {
	if (loaded) return;
	initBangData(buf);
	await Promise.all([loadCustomBangs(), loadDefaultBang()]);
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
	await Promise.all([loadCustomBangs(), loadDefaultBang()]);
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

function getSid(entryIdx: number): number {
	const base = SID_PTR + entryIdx * 2;
	return HEAP![base] | (HEAP![base+1]<<8);
}

function getChecksum(entryIdx: number): number {
	const base = CHK_PTR + entryIdx * 2;
	return HEAP![base] | (HEAP![base+1]<<8);
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

// Slot mixing must match the packing step (packbang.ts): each displacement
// finalizes a mixed hash so placement attempts scatter independently.
const SLOT_MIX_A = 0x21f0aaad;
const SLOT_MIX_B = 0x735a2d97;
const GOLDEN = 0x9e3779b9;

function mphSlot(hash: number, displacement: number): number {
	let x = (hash + Math.imul(displacement + 1, GOLDEN)) >>> 0;
	x ^= x >>> 16;
	x = Math.imul(x, SLOT_MIX_A) >>> 0;
	x ^= x >>> 15;
	x = Math.imul(x, SLOT_MIX_B) >>> 0;
	x ^= x >>> 15;
	return (x >>> 0) % N;
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

	// Data is stored in slot order, so the MPHF slot is the entry index.
	const entryIdx = displacement >= 0
		? mphSlot(hash, displacement)
		: -(displacement + 1);

	// Verify against the stored checksum (high 16 bits of the hash). Guards
	// against an unknown trigger landing on some real entry's slot.
	if (getChecksum(entryIdx) !== ((hash >>> 16) & 0xffff)) return null;
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

	// Build URL: prefix (inlined per entry) + encoded query + interned suffix.
	const pStart = PBLOB_PTR + POFF![entryIdx];
	const pEnd = PBLOB_PTR + POFF![entryIdx + 1];
	let url = new TextDecoder().decode(HEAP!.subarray(pStart, pEnd));
	url += encodeURIComponent(query);

	const sid = getSid(entryIdx);
	if (sid !== SID_NONE) {
		const sStart = SBLOB_PTR + SOFF![sid];
		const sEnd = SBLOB_PTR + SOFF![sid + 1];
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

	if (event.data?.type === "SET_DEFAULT_BANG") {
		const next = String(event.data.trigger ?? "").toLowerCase();
		if (next) {
			defaultBang = next;
			try {
				const cache = await caches.open(USER_CACHE);
				await cache.put(DEFAULT_BANG_KEY, new Response(next));
			} catch {
				// In-memory value still applies for this session.
			}
		}
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

	if (event.data?.type === "MIGRATE_SEARCH_COUNT") {
		// The old page-based version kept the search count in localStorage, which
		// the worker cannot read. The page hands it over here on first load after
		// the upgrade. Guarded by LS_MIGRATED_KEY so reloads or a second tab can
		// never fold it in twice.
		const port = event.ports?.[0];
		const ack = () => port?.postMessage({ type: "SEARCH_COUNT_MIGRATED" });
		const legacy = Number(event.data.count);
		try {
			const db = await openStatsDB();
			const tx = db.transaction(DB_STORE, "readwrite");
			const store = tx.objectStore(DB_STORE);
			// Issue both reads before awaiting so the transaction stays active.
			const read = (key: string) =>
				new Promise<number | undefined>((resolve) => {
					const req = store.get(key);
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => resolve(undefined);
				});
			const [already, current] = await Promise.all([
				read(LS_MIGRATED_KEY),
				read(SEARCH_COUNT_KEY),
			]);
			if (!already) {
				if (Number.isFinite(legacy) && legacy > 0) {
					store.put((current ?? 0) + legacy, SEARCH_COUNT_KEY);
				}
				store.put(1, LS_MIGRATED_KEY);
			}
			await new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		} catch {
			// Non-critical; the page keeps the localStorage value and retries.
		}
		ack();
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

self.addEventListener("fetch", (event: FetchEvent) => {
	const url = new URL(event.request.url);

	// `url.pathname` is a getter that re-serializes on every read, which costs
	// far more than the comparisons below. Read it once.
	const path = url.pathname;

	// Address-bar suggestions (OpenSearch). Served locally so the query never
	// leaves the device.
	if (path === "/suggest" && url.origin === self.location.origin) {
		event.respondWith(handleSuggest(url));
		return;
	}

	if (event.request.mode !== "navigate") return;

	const q = url.searchParams.get("q");
	if (!q || q.trim() === "") return;

	const trimmed = q.trim();
	// Leave the settings shortcut to the page.
	if (trimmed === "!" || trimmed === "!settings") return;

	// Accept a leading bang ("!g cats"), a trailing bang ("cats !g"), and the
	// suffix form ("cats g!"). Address-bar suggestions offer the first two, and
	// people type the third by hand, so all three have to resolve here.
	const leading = trimmed.match(/^!(\S+)\s*([\s\S]*)$/);
	const trailingBang = trimmed.match(/^([\s\S]*?)\s+!(\S+)$/);
	const trailingSuffix = trimmed.match(/^([\s\S]*?)\s*(\S+)!$/);

	let bangTrigger: string | null = null;
	let cleanQuery = trimmed;
	if (leading) {
		bangTrigger = leading[1].toLowerCase();
		cleanQuery = leading[2].trim();
	} else if (trailingBang) {
		bangTrigger = trailingBang[2].toLowerCase();
		cleanQuery = trailingBang[1].trim();
	} else if (trailingSuffix) {
		bangTrigger = trailingSuffix[2].toLowerCase();
		cleanQuery = trailingSuffix[1].trim();
	}

	event.respondWith(
		(async () => {
			try {
				await loadBangs();
				// A query with no explicit bang still goes to the user's default.
				const trigger = bangTrigger ?? defaultBang;
				const dest = resolve(trigger, cleanQuery);
				if (dest) {
					incrementSearchCount(); // background, non-blocking
					return Response.redirect(dest, 302);
				}
			} catch {
				// Fall through to the network so a data failure degrades into
				// the normal page instead of a dead tab.
			}
			return fetch(event.request);
		})(),
	);
});
