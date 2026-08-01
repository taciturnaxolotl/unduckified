// Address-bar search suggestions.
//
// This is the one part of unduck that cannot run on the client. Everything else
// happens in the Service Worker, but suggestion requests never reach it:
// Chromium issues them from the browser process through SimpleURLLoader,
// directly against the network stack, so the request has no client document and
// no Service Worker fetch event is ever dispatched (crbug 41389229). Firefox's
// urlbar behaves the same way from the parent process. A Service Worker route
// for this simply never runs, which is why the previous one silently returned
// the SPA's HTML to a browser that wanted JSON.
//
// So it runs at the edge instead. The tradeoff is real and worth stating: while
// suggestions are enabled, the partial text typed in the address bar reaches
// this function. Redirects are unaffected and still happen entirely on device.
// Nothing here is logged or stored, and the response carries `no-store`, but
// the request does leave the machine. Removing the suggestions URL from the
// search engine configuration stops it.
//
// The data is embedded in the bundle rather than read from KV, R2, or static
// assets. It is about 47 KiB gzipped, roughly 1.5% of the free-tier bundle
// budget, and embedding means a suggestion is answered with zero I/O: no
// subrequest to wait on, nothing to cache, no cold-fetch penalty on the first
// request to each edge location.

import {
	DOMAINS,
	ENTRY_DOMAIN_B64,
	ENTRY_SERVICE_B64,
	RANKS_B64,
	SERVICE_NAMES,
	TRIGGERS,
} from "../src/bangs/suggest-data.ts";

const SUGGEST_LIMIT = 8;

// All of these derive from module-level constants, so they are built once per
// isolate and reused by every request it serves. The splits and decodes cost
// about a millisecond combined; doing them per request would waste most of the
// CPU budget.
const triggers = TRIGGERS.split("\n");
const ranks = decodeBytes(RANKS_B64);
const serviceNames = SERVICE_NAMES.split("\n");
const domains = DOMAINS.split("\n");
const entryService = decodeU16(ENTRY_SERVICE_B64);
const entryDomain = decodeU16(ENTRY_DOMAIN_B64);

function decodeBytes(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Little-endian u16 pairs, packed by packbang.ts.
function decodeU16(b64: string): Uint16Array {
	const bytes = decodeBytes(b64);
	const out = new Uint16Array(bytes.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
	}
	return out;
}

// Triggers are stored in the same sort order packbang.ts wrote them in, so a
// prefix match is one contiguous range. Binary search for where it starts,
// about 14 steps over 13.5k entries.
function lowerBound(prefix: string): number {
	let lo = 0;
	let hi = triggers.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (triggers[mid] < prefix) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// Order by popularity, then by shorter trigger, then alphabetically. Index
// ascending is alphabetical here, since the list is sorted.
function beats(a: number, b: number): boolean {
	if (ranks[a] !== ranks[b]) return ranks[a] > ranks[b];
	const la = triggers[a].length;
	const lb = triggers[b].length;
	if (la !== lb) return la < lb;
	return a < b;
}

// A matching range can be large: "s" matches over a thousand entries and an
// empty prefix matches all 13.5k. Keeping a bounded top-K list means the scan
// stays linear in the range with no sort, which holds the worst case (an empty
// prefix) near 0.17 ms against a 10 ms budget. Returns entry indices so the
// response builder can attach each one's description metadata.
function suggestIndices(prefix: string): number[] {
	const top: number[] = [];
	for (let i = lowerBound(prefix); i < triggers.length; i++) {
		if (!triggers[i].startsWith(prefix)) break;

		// Skip early when this cannot displace the current worst entry.
		if (top.length === SUGGEST_LIMIT && !beats(i, top[SUGGEST_LIMIT - 1])) {
			continue;
		}

		let pos = top.length < SUGGEST_LIMIT ? top.length : SUGGEST_LIMIT - 1;
		top[pos] = i;
		while (pos > 0 && beats(top[pos], top[pos - 1])) {
			const swap = top[pos];
			top[pos] = top[pos - 1];
			top[pos - 1] = swap;
			pos--;
		}
	}
	return top;
}

// Pull a partial bang out of a query. Accepts a leading bang ("!git") and a
// trailing one ("cats !git"), mirroring the orders the redirect handler
// understands, and returns the text to put back in front of the completion.
function parsePartialBang(
	query: string,
): { prefix: string; partial: string } | null {
	const leading = query.match(/^!(\S*)$/);
	if (leading) return { prefix: "", partial: leading[1].toLowerCase() };

	const trailing = query.match(/^(.*\s)!(\S*)$/);
	if (trailing) {
		return { prefix: trailing[1], partial: trailing[2].toLowerCase() };
	}

	return null;
}

// A description for the dropdown. When the service name already says where it
// goes ("emojipedia" on emojipedia.org, "YouTube" on youtube.com), naming the
// domain too just repeats it, so it is dropped. Otherwise the domain earns its
// place ("DeepL Translator — deepl.com"). packbang.ts strips the "www." prefix
// from every domain, so none is removed here.
function describe(entry: number): string {
	const name = serviceNames[entryService[entry]];
	const domain = domains[entryDomain[entry]];
	// Compare loosely: drop non-alphanumerics and case so "Can I use..." matches
	// caniuse.com and "Google PT" still keeps its domain.
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	const base = domain.split(".")[0];
	return normalized === base ? name : `${name} — ${domain}`;
}

// The favicon URL comes from the domain, so nothing about it is stored. The
// base URL for a query is the bare origin: the suggestion is a bang, and the
// bang with no search term resolves to the service's own front door.
function originOf(entry: number): string {
	return `https://${domains[entryDomain[entry]]}`;
}

const HEADERS = {
	"Content-Type": "application/x-suggestions+json",
	// Queries are personal and every one is different. Never store them in a
	// shared cache, and never let one user's response reach another.
	"Cache-Control": "private, no-store",
};

// OpenSearch suggestions: [query, [completions], [descriptions], [queryURLs]].
// Firefox and Chromium both skip the plain descriptions and URLs and instead
// read a trailing "google:suggestdetail" object: "a" is the annotation shown
// under the completion, "i" the icon next to it. So the fourth array element is
// what actually makes the dropdown rich, and the positional ones are included
// for any client that reads them plainly.
function suggestionsResponse(
	query: string,
	completions: string[],
	entries: number[],
	rich: boolean,
): Response {
	let body: unknown[];
	if (!rich || entries.length === 0) {
		body = [query, completions, [], []];
	} else {
		const descriptions = entries.map(describe);
		const urls = entries.map(originOf);
		const detail = entries.map((entry) => ({
			a: describe(entry),
			i: `${originOf(entry)}/favicon.ico`,
		}));
		body = [query, completions, descriptions, urls, { "google:suggestdetail": detail }];
	}
	return new Response(JSON.stringify(body), { headers: HEADERS });
}

export function onRequestGet(context: { request: Request }): Response {
	const url = new URL(context.request.url);
	const query = url.searchParams.get("q") ?? "";
	// Descriptions and favicons are on by default; "?rich=0" drops back to a
	// plain four-element response for clients that do not want the extra weight.
	const rich = url.searchParams.get("rich") !== "0";

	// Only complete an actual bang. A plain search term has nothing to offer
	// here, and answering it would mean reading queries that are none of our
	// business.
	const bang = parsePartialBang(query.trim());
	if (!bang) return suggestionsResponse(query, [], [], rich);

	const entries = suggestIndices(bang.partial);
	return suggestionsResponse(
		query,
		entries.map((i) => `${bang.prefix}!${triggers[i]}`),
		entries,
		rich,
	);
}
