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

import { RANKS_B64, TRIGGERS } from "../src/bangs/suggest-data.ts";

const SUGGEST_LIMIT = 8;

// Both derive from a module-level constant, so they are built once per isolate
// and reused by every request it serves. The split costs about half a
// millisecond; doing it per request would waste most of the CPU budget.
const triggers = TRIGGERS.split("\n");
const ranks = Uint8Array.from(atob(RANKS_B64), (c) => c.charCodeAt(0));

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
// prefix) near 0.17 ms against a 10 ms budget.
function suggest(prefix: string): string[] {
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
	return top.map((i) => triggers[i]);
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

// OpenSearch suggestions: [query, [completions], [descriptions], [urls]].
function suggestionsResponse(query: string, completions: string[]): Response {
	return new Response(JSON.stringify([query, completions, [], []]), {
		headers: {
			"Content-Type": "application/x-suggestions+json",
			// Queries are personal and every one is different. Never store them
			// in a shared cache, and never let one user's response reach another.
			"Cache-Control": "private, no-store",
		},
	});
}

export function onRequestGet(context: { request: Request }): Response {
	const url = new URL(context.request.url);
	const query = url.searchParams.get("q") ?? "";

	// Only complete an actual bang. A plain search term has nothing to offer
	// here, and answering it would mean reading queries that are none of our
	// business.
	const bang = parsePartialBang(query.trim());
	if (!bang) return suggestionsResponse(query, []);

	return suggestionsResponse(
		query,
		suggest(bang.partial).map((trigger) => `${bang.prefix}!${trigger}`),
	);
}
