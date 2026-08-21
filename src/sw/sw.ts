// Service Worker: MPHF-based redirect with zero-decode binary artifact.

import { BANG_DATA_VERSION } from "../bangs/data-version.ts";
import { type Catalog, openCatalog, resolveQuery } from "../bangs/catalog.ts";

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

let catalog: Catalog | null = null;

// Custom bangs cache: Map<shortcut, {prefix, suffix}>
let customBangsCache = new Map<string, { prefix: string; suffix: string | null }>();

// Search count tracking via IndexedDB.
//
// The connection is held open for the life of the worker rather than opened
// per search. Opening and closing one costs ~57 µs against ~89 µs for the
// transaction itself, and a warm redirect is only ~500 µs end to end, so the
// churn was a measurable share of every search for a counter nobody is waiting
// on. A failed open is not cached, so a later search can try again.
let statsDB: Promise<IDBDatabase> | null = null;
function openStatsDB(): Promise<IDBDatabase> {
	if (!statsDB) {
		statsDB = new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				req.result.createObjectStore(DB_STORE);
			};
			req.onsuccess = () => {
				// A held connection blocks an upgrade from another tab, so let go
				// when one is requested and reopen on the next use.
				req.result.onversionchange = () => {
					req.result.close();
					statsDB = null;
				};
				resolve(req.result);
			};
			req.onerror = () => reject(req.error);
		}).catch((err) => {
			statsDB = null;
			throw err;
		});
	}
	return statsDB;
}

async function incrementSearchCount(key: string = SEARCH_COUNT_KEY, by = 1): Promise<void> {
	if (by <= 0) return;
	try {
		const db = await openStatsDB();
		const tx = db.transaction(DB_STORE, "readwrite");
		const store = tx.objectStore(DB_STORE);
		const current = await new Promise<number>((resolve) => {
			const getReq = store.get(key);
			getReq.onsuccess = () => resolve(getReq.result ?? 0);
			getReq.onerror = () => resolve(0);
		});
		store.put(current + by, key);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// Stats are non-critical, swallow errors
	}
}

// Counting a search must not delay the redirect it is counting.
//
// Calling this unawaited looks free, but an async function that suspends on an
// already-settled promise resumes as a microtask, and microtasks drain ahead of
// the response being handed back — so the write was landing *before* the
// redirect, not after it. Profiling both workers made the shape of it clear:
// IndexedDB is 25% of our per-navigation CPU, and the fetch handler settled in
// 121 us against flashbang's 72 us despite flashbang burning more CPU overall,
// because they push their work past the response and we did not.
//
// A timer is a macrotask, so it cannot cut in line, and batching means a burst
// of searches costs one transaction instead of one each. waitUntil keeps the
// worker alive long enough to land the write.
const FLUSH_DELAY_MS = 2_000;
let pendingSearches = 0;
let flushScheduled = false;

function countSearch(event: FetchEvent): void {
	pendingSearches++;
	if (flushScheduled) return;
	flushScheduled = true;
	event.waitUntil(
		new Promise<void>((resolve) => {
			setTimeout(() => {
				flushScheduled = false;
				const n = pendingSearches;
				pendingSearches = 0;
				incrementSearchCount(SEARCH_COUNT_KEY, n).finally(resolve);
			}, FLUSH_DELAY_MS);
		}),
	);
}

const DEFAULT_BANG_KEY = "default-bang";
let defaultBang = "ddg";

// caches.open costs ~0.2 ms and every boot did it three times before it could
// answer anything: once for the catalog and once for each of the two settings.
// The handles are memoized for the life of the worker, and a rejection is not,
// so a failed open can be retried.
let userCache: Promise<Cache> | null = null;
function openUserCache(): Promise<Cache> {
	if (!userCache) {
		userCache = caches.open(USER_CACHE).catch((err) => {
			userCache = null;
			throw err;
		});
	}
	return userCache;
}

let dataCache: Promise<Cache> | null = null;
function openDataCache(): Promise<Cache> {
	if (!dataCache) {
		dataCache = caches.open(CACHE_NAME).catch((err) => {
			dataCache = null;
			throw err;
		});
	}
	return dataCache;
}

// Both settings live in the same cache, so read them through one handle and
// one pass rather than opening it twice.
async function loadSettings() {
	let cache: Cache;
	try {
		cache = await openUserCache();
	} catch {
		return; // built-in default, no custom bangs
	}
	const [defaultResp, customResp] = await Promise.all([
		cache.match(DEFAULT_BANG_KEY).catch(() => undefined),
		cache.match(CUSTOM_BANGS_KEY).catch(() => undefined),
	]);
	if (defaultResp) {
		try {
			defaultBang = (await defaultResp.text()) || "ddg";
		} catch {
			// Keep the built-in default.
		}
	}
	if (customResp) {
		try {
			// Data is already in {prefix, suffix} format from message handler
			customBangsCache = new Map(Object.entries(await customResp.json()));
		} catch (err) {
			console.warn("Failed to load custom bangs:", err);
		}
	}
}

// Adopt bang data handed over by the page. The page-level fallback downloads
// bangs.bin to answer the very first query, so it passes the bytes along
// instead of making the worker fetch the same file a second time.
async function seedBangData(buf: ArrayBuffer) {
	if (catalog) return;
	catalog = openCatalog(buf);
	await loadSettings();
	// Persist so later worker starts skip the network entirely.
	try {
		const cache = await openDataCache();
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
	const cache = await openDataCache();

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

	catalog = openCatalog(await resp.arrayBuffer());
	await loadSettings();
}

function loadBangs(): Promise<void> {
	if (catalog) return Promise.resolve();
	// Share one in-flight load so concurrent navigations don't stampede.
	if (!bangDataPromise) {
		bangDataPromise = loadBangsUncached().catch((err) => {
			bangDataPromise = null; // allow a retry on the next request
			throw err;
		});
	}
	return bangDataPromise;
}

function resolveCustom(trigger: string, query: string): string | null {
	const entry = customBangsCache.get(trigger);
	if (!entry) return null;
	if (!query) {
		try { return new URL(entry.prefix).origin; } catch {}
	}
	return entry.prefix + encodeURIComponent(query) + (entry.suffix || "");
}

function bangExists(trigger: string): boolean {
	return customBangsCache.has(trigger) || (catalog?.has(trigger) ?? false);
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
		openUserCache().then((cache) => {
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
				const cache = await openUserCache();
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
		if (catalog) {
			reply(true);
		} else {
			// Not parsed yet, but a cached copy still means no download is needed.
			try {
				const cache = await openDataCache();
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
			reply(count + pendingSearches);
		} catch {
			reply(pendingSearches);
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
	if (q === null || q.trim() === "") return;

	const trimmed = q.trim();
	// Leave the settings shortcut to the page.
	if (trimmed === "!" || trimmed === "!settings") return;

	event.respondWith(
		(async () => {
			try {
				await loadBangs();
				const dest = resolveQuery(catalog, trimmed, {
					defaultTrigger: defaultBang,
					custom: resolveCustom,
				});
				if (dest) {
					countSearch(event); // batched, and never before the response
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
