// Reading side of bangs.bin: the MPHF lookup, and the query grammar that
// decides which trigger a search is asking for.
//
// Three places need this and must agree exactly, or the same search resolves
// differently depending on which one answers it: the service worker (warm),
// the page fallback (cold, before the worker controls anything), and anything
// running at the edge. The packing side lives in packbang.ts; the constants
// here are its mirror image and the two move together.
//
// A catalog is an object rather than module state because those consumers do
// not share a lifetime. Nothing here touches the DOM, localStorage, or caches:
// callers keep their own storage and hand in what they know.

const MAGIC = 0x554e4455;
const FORMAT_VERSION = 9;
const SID_NONE = 0xffff;

// Slot mixing must match the packing step (packbang.ts): each displacement
// finalizes a mixed hash so placement attempts scatter independently.
const SLOT_MIX_A = 0x21f0aaad;
const SLOT_MIX_B = 0x735a2d97;
const GOLDEN = 0x9e3779b9;

export interface Catalog {
	/** Resolve a builtin trigger, or null if it is not in the catalog. */
	resolve(trigger: string, query: string): string | null;
	/** Whether a trigger exists, without building its URL. */
	has(trigger: string): boolean;
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

/** Parse the header, then serve lookups straight out of the given bytes. */
export function openCatalog(buffer: ArrayBuffer): Catalog {
	const HEAP = new Uint8Array(buffer);

	let p = 0;
	const r32 = () => {
		const v = HEAP[p] | (HEAP[p + 1] << 8) | (HEAP[p + 2] << 16) | (HEAP[p + 3] << 24);
		p += 4;
		return v >>> 0;
	};

	const magic = r32();
	const version = r32();
	if (magic !== MAGIC || version !== FORMAT_VERSION) throw new Error("bad bangs.bin");

	const N = r32();
	const BUCKET_COUNT = r32();
	const nSuffixes = r32();

	// Read `count` LEB128 varint lengths and prefix-sum them into an offset
	// table of size count+1, advancing p past the varint stream.
	const readOffsets = (count: number): Uint32Array => {
		const offsets = new Uint32Array(count + 1);
		let acc = 0;
		for (let i = 0; i < count; i++) {
			let v = 0, shift = 0, b: number;
			do { b = HEAP[p++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
			offsets[i] = acc;
			acc += v >>> 0;
		}
		offsets[count] = acc;
		return offsets;
	};

	// Offset tables are reconstructed at load from the wire's varint length
	// streams. Entry order is MPHF-slot order, so an entry index is also its slot.
	const DISP_PTR = p;
	p += 4 * BUCKET_COUNT; // Int32 displacements
	const CHK_PTR = p;
	p += 2 * N; // u16 verification checksum per entry
	const POFF = readOffsets(N);
	const PBLOB_PTR = p;
	p += POFF[N];
	const SID_PTR = p;
	p += 2 * N; // u16 suffix index per entry (0xffff = none)
	const SOFF = readOffsets(nSuffixes);
	const SBLOB_PTR = p;
	// Nothing reads past the suffix blob.

	const getDisp = (bucketId: number): number => {
		const base = DISP_PTR + bucketId * 4;
		// Little-endian signed Int32; the `<< 24` restores the sign bit.
		return HEAP[base] | (HEAP[base + 1] << 8) | (HEAP[base + 2] << 16) | (HEAP[base + 3] << 24);
	};
	const getSid = (entryIdx: number): number =>
		HEAP[SID_PTR + entryIdx * 2] | (HEAP[SID_PTR + entryIdx * 2 + 1] << 8);
	const getChecksum = (entryIdx: number): number =>
		HEAP[CHK_PTR + entryIdx * 2] | (HEAP[CHK_PTR + entryIdx * 2 + 1] << 8);

	const mphSlot = (hash: number, displacement: number): number => {
		let x = (hash + Math.imul(displacement + 1, GOLDEN)) >>> 0;
		x ^= x >>> 16;
		x = Math.imul(x, SLOT_MIX_A) >>> 0;
		x ^= x >>> 15;
		x = Math.imul(x, SLOT_MIX_B) >>> 0;
		x ^= x >>> 15;
		return (x >>> 0) % N;
	};

	// MPHF lookup with trigger verification. Returns the entry index, or null if
	// the trigger is not actually present (guards against hash collisions / misses).
	const lookupEntry = (trigger: string): number | null => {
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
	};

	const decoder = new TextDecoder();

	return {
		has: (trigger) => lookupEntry(trigger) !== null,

		resolve(trigger, query) {
			const entryIdx = lookupEntry(trigger);
			if (entryIdx === null) return null;

			// Build URL: prefix (inlined per entry) + encoded query + interned suffix.
			let url = decoder.decode(
				HEAP.subarray(PBLOB_PTR + POFF[entryIdx], PBLOB_PTR + POFF[entryIdx + 1]),
			);

			if (!query) {
				try { return new URL(url).origin; } catch {}
			}

			url += encodeURIComponent(query);

			const sid = getSid(entryIdx);
			if (sid !== SID_NONE) {
				url += decoder.decode(
					HEAP.subarray(SBLOB_PTR + SOFF[sid], SBLOB_PTR + SOFF[sid + 1]),
				);
			}

			return url;
		},
	};
}

export interface ParsedQuery {
	/** The trigger the user typed, or null when they typed none. */
	trigger: string | null;
	/** The search text with the bang removed. */
	cleanQuery: string;
	/** The original text, trimmed. What an unknown bang falls back to. */
	trimmed: string;
}

/**
 * Accept a leading bang ("!g cats"), a trailing bang ("cats !g"), and the
 * suffix form ("cats g!"). Address-bar suggestions offer the first two, and
 * people type the third by hand, so all three have to resolve.
 */
export function parseBangQuery(query: string): ParsedQuery {
	const trimmed = query.trim();
	const leading = trimmed.match(/^!(\S+)\s*([\s\S]*)$/);
	const trailingBang = trimmed.match(/^([\s\S]*?)\s+!(\S+)$/);
	const trailingSuffix = trimmed.match(/^([\s\S]*?)\s*(\S+)!$/);

	if (leading) return { trigger: leading[1].toLowerCase(), cleanQuery: leading[2].trim(), trimmed };
	if (trailingBang) return { trigger: trailingBang[2].toLowerCase(), cleanQuery: trailingBang[1].trim(), trimmed };
	if (trailingSuffix) return { trigger: trailingSuffix[2].toLowerCase(), cleanQuery: trailingSuffix[1].trim(), trimmed };
	return { trigger: null, cleanQuery: trimmed, trimmed };
}

export interface ResolveOptions {
	/** Where a query with no bang goes, and where an unknown bang lands. */
	defaultTrigger: string;
	/**
	 * User-defined bangs, which take priority over the catalog. Each consumer
	 * keeps them in its own store, so it hands in a lookup rather than data.
	 */
	custom?: (trigger: string, query: string) => string | null;
}

/**
 * Some bangs are site searches rather than destinations, and upstream spells
 * those as a path with no host ("/search?q={{{s}}}+site:4chan.org", or Kagi's
 * "/{{{s}}}+unix+time"). The host they are relative to is whichever engine you
 * search with, so the terms go back through the default bang. Resolving them
 * against our own origin instead is how they used to land on our 404 page.
 */
function siteSearchTerms(dest: string): string | null {
	let url: URL;
	try {
		url = new URL(dest, "https://unduck.invalid");
	} catch {
		return null;
	}
	// `q` if there is one, otherwise the path itself. Both spell a space as
	// "+", which has to go before decoding so an encoded "+" survives.
	const terms =
		url.searchParams.get("q") ??
		decodeURIComponent(url.pathname.slice(1).replace(/\+/g, " "));
	return terms.trim() || null;
}

/**
 * The whole redirect decision: parse the query, prefer a custom bang, fall back
 * to the catalog. A query with no explicit bang goes to the user's default. An
 * unknown bang is stripped and the whole text goes there too, rather than
 * dropping the user on the homepage. Null means "we have no answer, show the
 * page".
 */
export function resolveQuery(
	catalog: Catalog | null,
	query: string,
	{ defaultTrigger, custom }: ResolveOptions,
): string | null {
	const { trigger: typed, cleanQuery, trimmed } = parseBangQuery(query);
	const trigger = typed ?? defaultTrigger;

	const direct = (t: string, q: string) => custom?.(t, q) ?? catalog?.resolve(t, q) ?? null;
	const answer = (t: string, q: string): string | null => {
		const dest = direct(t, q);
		if (!dest || !dest.startsWith("/")) return dest;
		const terms = siteSearchTerms(dest);
		// One hop only: a default bang that is itself a site search has nowhere
		// to send this, so let the page deal with it.
		const onDefault = terms === null ? null : direct(defaultTrigger, terms);
		return onDefault?.startsWith("/") ? null : onDefault;
	};

	const dest = answer(trigger, cleanQuery);
	if (dest) return dest;
	// An unknown bang was typed: keep the text whole and hand it to the default.
	return typed !== null ? answer(defaultTrigger, trimmed) : null;
}
