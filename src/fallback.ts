// Fallback module: runs in main thread when SW isn't active yet
// Reuses the same bangs.bin parsing logic as the service worker

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
let loaded = false;

export async function initializeBangData(buffer: ArrayBuffer): Promise<void> {
	if (loaded) return;
	HEAP = new Uint8Array(buffer);

	let p = 0;
	const r32 = () => {
		const v = HEAP![p] | (HEAP![p + 1] << 8) | (HEAP![p + 2] << 16) | (HEAP![p + 3] << 24);
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
	p += 2 * BUCKET_COUNT;
	SLOT_PTR = p;
	p += 2 * N;
	PID_PTR = p;
	p += 2 * N;
	SID_PTR = p;
	p += 2 * N;
	POFF_PTR = p;
	p += 4 * (nPrefixes + 1);
	PBLOB_PTR = p;
	const prefixBlobEnd = (() => {
		const base = POFF_PTR + nPrefixes * 4;
		return (HEAP![base] | (HEAP![base + 1] << 8) | (HEAP![base + 2] << 16) | (HEAP![base + 3] << 24)) >>> 0;
	})();
	p += prefixBlobEnd;
	SOFF_PTR = p;
	p += 4 * (nSuffixes + 1);
	SBLOB_PTR = p;
	const suffixBlobEnd = (() => {
		const base = SOFF_PTR + nSuffixes * 4;
		return (HEAP![base] | (HEAP![base + 1] << 8) | (HEAP![base + 2] << 16) | (HEAP![base + 3] << 24)) >>> 0;
	})();
	p += suffixBlobEnd;
	TOFF_PTR = p;
	p += 4 * (N + 1);
	TBLOB_PTR = p;

	loaded = true;
}

function getDisp(bucketId: number): number {
	const base = DISP_PTR + bucketId * 2;
	const v = HEAP![base] | (HEAP![base + 1] << 8);
	return v < 0x8000 ? v : v - 0x10000;
}

function getSlotEntry(slot: number): number {
	const base = SLOT_PTR + slot * 2;
	return HEAP![base] | (HEAP![base + 1] << 8);
}

function getPid(entryIdx: number): number {
	const base = PID_PTR + entryIdx * 2;
	return HEAP![base] | (HEAP![base + 1] << 8);
}

function getSid(entryIdx: number): number {
	const base = SID_PTR + entryIdx * 2;
	const v = HEAP![base] | (HEAP![base + 1] << 8);
	return v < 0x8000 ? v : v - 0x10000;
}

function getPrefixOffset(idx: number): number {
	const base = POFF_PTR + idx * 4;
	return (HEAP![base] | (HEAP![base + 1] << 8) | (HEAP![base + 2] << 16) | (HEAP![base + 3] << 24)) >>> 0;
}

function getSuffixOffset(idx: number): number {
	const base = SOFF_PTR + idx * 4;
	return (HEAP![base] | (HEAP![base + 1] << 8) | (HEAP![base + 2] << 16) | (HEAP![base + 3] << 24)) >>> 0;
}

function getTriggerOffset(idx: number): number {
	const base = TOFF_PTR + idx * 4;
	return (HEAP![base] | (HEAP![base + 1] << 8) | (HEAP![base + 2] << 16) | (HEAP![base + 3] << 24)) >>> 0;
}

function getTrigger(entryIdx: number): string {
	const start = TBLOB_PTR + getTriggerOffset(entryIdx);
	const end = TBLOB_PTR + getTriggerOffset(entryIdx + 1);
	return new TextDecoder().decode(HEAP!.subarray(start, end));
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

function resolve(trigger: string, query: string): string | null {
	const entryIdx = lookupEntry(trigger);
	if (entryIdx === null) return null;

	const pid = getPid(entryIdx);
	const sid = getSid(entryIdx);

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

export async function resolveFallback(query: string, buffer?: ArrayBuffer): Promise<string | null> {
	// Fetch bangs.bin if not already loaded
	if (!loaded) {
		if (!buffer) {
			const resp = await fetch("/bangs.bin");
			buffer = await resp.arrayBuffer();
		}
		await initializeBangData(buffer);
	}

	// Parse bang syntax. Must match the service worker exactly: leading
	// ("!g cats"), trailing ("cats !g"), and suffix ("cats g!") forms.
	const trimmed = query.trim();
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

	// A query typed without a bang still goes to the user's default.
	const trigger =
		bangTrigger ?? (localStorage.getItem("default-bang") || "ddg").toLowerCase();

	// Check custom bangs from localStorage first
	const customBangs = JSON.parse(localStorage.getItem("custom-bangs") || "{}");
	const customEntry = customBangs[trigger];
	if (customEntry) {
		const url = customEntry.u;
		const idx = url.indexOf("{{{s}}}");
		if (idx === -1) return url;
		return url.substring(0, idx) + encodeURIComponent(cleanQuery) + url.substring(idx + 7);
	}

	// Fall back to built-in bangs
	return resolve(trigger, cleanQuery);
}

// Expose globally for inline script
declare global {
	interface Window {
		resolveFallback: typeof resolveFallback;
	}
}
window.resolveFallback = resolveFallback;

// Signal that the fallback module is ready
if (typeof window !== "undefined") {
	window.dispatchEvent(new Event("fallbackReady"));
}
