// Fallback module: runs in main thread when SW isn't active yet
// Reuses the same bangs.bin parsing logic as the service worker

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
	if (magic !== 0x554e4455 || version !== 9) throw new Error("bad bangs.bin");

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
	p += 4 * BUCKET_COUNT; // Int32 displacements
	CHK_PTR = p;
	p += 2 * N;
	POFF = readOffsets(N);
	PBLOB_PTR = p;
	p += POFF[N];
	SID_PTR = p;
	p += 2 * N;
	SOFF = readOffsets(nSuffixes);
	SBLOB_PTR = p;

	loaded = true;
}

function getDisp(bucketId: number): number {
	const base = DISP_PTR + bucketId * 4;
	// Little-endian signed Int32; the `<< 24` restores the sign bit.
	return HEAP![base] | (HEAP![base + 1] << 8) | (HEAP![base + 2] << 16) | (HEAP![base + 3] << 24);
}

function getSid(entryIdx: number): number {
	const base = SID_PTR + entryIdx * 2;
	return HEAP![base] | (HEAP![base + 1] << 8);
}

function getChecksum(entryIdx: number): number {
	const base = CHK_PTR + entryIdx * 2;
	return HEAP![base] | (HEAP![base + 1] << 8);
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

function resolve(trigger: string, query: string): string | null {
	const entryIdx = lookupEntry(trigger);
	if (entryIdx === null) return null;

	const pStart = PBLOB_PTR + POFF![entryIdx];
	const pEnd = PBLOB_PTR + POFF![entryIdx + 1];
	let url = new TextDecoder().decode(HEAP!.subarray(pStart, pEnd));

	if (!query) {
		try { return new URL(url).origin; } catch {}
	}

	url += encodeURIComponent(query);

	const sid = getSid(entryIdx);
	if (sid !== SID_NONE) {
		const sStart = SBLOB_PTR + SOFF![sid];
		const sEnd = SBLOB_PTR + SOFF![sid + 1];
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

	// A query typed without a bang still goes to the user's default. An
	// unknown bang is stripped and the whole text goes there too, rather
	// than dropping the user on the homepage.
	const defaultTrigger = (
		localStorage.getItem("default-bang") || "ddg"
	).toLowerCase();
	const explicit = bangTrigger !== null;
	const trigger = bangTrigger ?? defaultTrigger;

	// Check custom bangs from localStorage first
	const customBangs = JSON.parse(localStorage.getItem("custom-bangs") || "{}");
	const customEntry = customBangs[trigger];
	if (customEntry) {
		const url = customEntry.u;
		const idx = url.indexOf("{{{s}}}");
		if (idx === -1) return url;
		if (!cleanQuery) {
			try { return new URL(url.substring(0, idx)).origin; } catch {}
		}
		return url.substring(0, idx) + encodeURIComponent(cleanQuery) + url.substring(idx + 7);
	}

	// Fall back to built-in bangs
	const dest = resolve(trigger, cleanQuery);
	if (dest) return dest;
	return explicit ? resolve(defaultTrigger, trimmed) : null;
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
