// Service Worker: MPHF-based redirect with zero-decode binary artifact.

const CACHE_NAME = "unduck-sw-v3";
const BANGS_BIN = "/bangs.bin";

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

async function loadBangs() {
	if (loaded) return;
	const cache = await caches.open(CACHE_NAME);
	const resp = await cache.match(BANGS_BIN);
	if (!resp) throw new Error("bangs.bin not in cache");
	const buf = await resp.arrayBuffer();
	HEAP = new Uint8Array(buf);

	let p = 0;
	const r32 = () => {
		const v = HEAP![p] | (HEAP![p+1]<<8) | (HEAP![p+2]<<16) | (HEAP![p+3]<<24);
		p += 4;
		return v >>> 0;
	};

	const magic = r32();
	const version = r32();
	if (magic !== 0x554e4455 || version !== 3) throw new Error("bad bangs.bin");

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

	loaded = true;
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

function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	const bytes = new TextEncoder().encode(str);
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function resolve(trigger: string, query: string): string | null {
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

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then(async (cache) => {
			await cache.addAll([BANGS_BIN]);
		}),
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event: FetchEvent) => {
	const url = new URL(event.request.url);
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
				if (dest) return Response.redirect(dest, 302);
			}
			return fetch(event.request);
		})(),
	);
});
