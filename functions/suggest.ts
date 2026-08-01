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
	ENDPOINT_SHAPE_IDX_B64,
	ENDPOINT_SHAPES,
	ENDPOINT_URLS,
	ENTRY_DOMAIN_B64,
	ENTRY_ENDPOINT_B64,
	ENTRY_SERVICE_B64,
	RANKS_B64,
	SERVICE_NAMES,
	TRIGGERS,
} from "../src/bangs/suggest-data.ts";

const SUGGEST_LIMIT = 8;
const ENDPOINT_NONE = 65535;

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
const endpointUrls = ENDPOINT_URLS.split("\n");
const endpointShapes = ENDPOINT_SHAPES.split("\n");
const endpointShapeIdx = decodeBytes(ENDPOINT_SHAPE_IDX_B64);
const entryEndpoint = decodeU16(ENTRY_ENDPOINT_B64);

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

// Exact-trigger lookup for the "bang followed by a space" case. The table is
// sorted, so this is one binary search rather than a prefix scan.
function findExact(trigger: string): number {
	let lo = 0;
	let hi = triggers.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (triggers[mid] < trigger) lo = mid + 1;
		else hi = mid;
	}
	return lo < triggers.length && triggers[lo] === trigger ? lo : -1;
}

// A leading bang with a space after it: "!gh react" -> { trigger: "gh", term:
// "react" }. The space is the boundary between completing the bang itself and
// asking the bang's own service for completions.
function parseBangTerm(query: string): { trigger: string; term: string } | null {
	const match = query.match(/^!(\S+)\s+(\S[\s\S]*)$/);
	if (!match) return null;
	return { trigger: match[1].toLowerCase(), term: match[2].trim() };
}

// Pull the completion strings out of an upstream payload. Each shape is one of
// the few well-known suggestion formats, recorded per endpoint by
// resolve-suggestions.ts. Anything unexpected yields no suggestions rather than
// a guess, so a changed upstream degrades to the bare completion instead of
// erroring.
function extractCompletions(shape: string, payload: unknown): string[] {
	try {
		if (shape === "opensearch") {
			// [query, [completions], ...] — MediaWiki, Google suggest.
			const list = (payload as unknown[])?.[1];
			return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
		}
		if (shape === "amazon") {
			// { suggestions: [{ value }] }
			const list = (payload as { suggestions?: { value?: unknown }[] })?.suggestions;
			return Array.isArray(list)
				? list.map((x) => x?.value).filter((x): x is string => typeof x === "string")
				: [];
		}
		if (shape === "npms") {
			// [{ package: { name } }]
			return Array.isArray(payload)
				? payload
						.map((x) => (x as { package?: { name?: unknown } })?.package?.name)
						.filter((x): x is string => typeof x === "string")
				: [];
		}
		if (shape === "reddit") {
			// { data: { children: [{ data: { display_name } }] } }
			const children = (payload as { data?: { children?: { data?: { display_name?: unknown } }[] } })
				?.data?.children;
			return Array.isArray(children)
				? children.map((x) => x?.data?.display_name).filter((x): x is string => typeof x === "string")
				: [];
		}
		if (shape === "crates") {
			// { crates: [{ name }] }
			const list = (payload as { crates?: { name?: unknown }[] })?.crates;
			return Array.isArray(list)
				? list.map((x) => x?.name).filter((x): x is string => typeof x === "string")
				: [];
		}
		if (shape === "algolia") {
			// { hits: [{ title|full_name }] } — Algolia and GitHub both nest here.
			const hits = (payload as { hits?: { title?: unknown; full_name?: unknown }[]; items?: { full_name?: unknown }[] });
			const list = hits?.hits ?? hits?.items;
			return Array.isArray(list)
				? list
						.map((x) => (typeof x.title === "string" ? x.title : x.full_name))
						.filter((x): x is string => typeof x === "string")
				: [];
		}
	} catch {
		// A malformed payload is not worth a failed request.
	}
	return [];
}

// Forward a term to a bang's own autocomplete API and read the completions it
// returns. The endpoint template carries a {q} placeholder. An upstream that is
// down, slow, or malformed yields an empty list, so the bang completion still
// answers the query on its own.
async function forwardToBang(
	trigger: string,
	term: string,
): Promise<string[]> {
	const entry = findExact(trigger);
	if (entry === -1) return [];
	const endpointIdx = entryEndpoint[entry];
	if (endpointIdx === ENDPOINT_NONE) return [];

	const url = endpointUrls[endpointIdx].replace(
		"{q}",
		encodeURIComponent(term),
	);
	const shape = endpointShapes[endpointShapeIdx[endpointIdx]];
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "unduckified-suggest/1.0" },
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return [];
		const payload: unknown = await res.json();
		return extractCompletions(shape, payload).slice(0, SUGGEST_LIMIT);
	} catch {
		return [];
	}
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

// A bare OpenSearch response with completions the function computed itself
// (not looked up from the bang table). Used for forwarded results, which have
// no per-entry metadata of ours to attach.
function plainResponse(query: string, completions: string[]): Response {
	return new Response(JSON.stringify([query, completions, [], []]), {
		headers: HEADERS,
	});
}

// Upstreams a plain query can be forwarded to when the user opts in with
// &forwarder=<name>. Off by default: without it, plain queries get no lookup
// and never leave this function. The list is the set of engines with a clean,
// keyless suggest API that answers the standard opensearch shape
// ([query, [completions], ...]).
const OPENSEARCH = "opensearch";
const FORWARD_ENGINES: Record<string, { url: string; shape: string }> = {
	ddg: { url: "https://duckduckgo.com/ac/?q={q}&type=list", shape: OPENSEARCH },
	duckduckgo: { url: "https://duckduckgo.com/ac/?q={q}&type=list", shape: OPENSEARCH },
	google: { url: "https://suggestqueries.google.com/complete/search?client=firefox&q={q}", shape: OPENSEARCH },
	g: { url: "https://suggestqueries.google.com/complete/search?client=firefox&q={q}", shape: OPENSEARCH },
	bing: { url: "https://www.bing.com/osjson.aspx?query={q}", shape: OPENSEARCH },
	b: { url: "https://www.bing.com/osjson.aspx?query={q}", shape: OPENSEARCH },
	brave: { url: "https://search.brave.com/api/suggest?q={q}&rich=false", shape: OPENSEARCH },
	yahoo: { url: "https://ff.search.yahoo.com/gossip?output=fxjson&command={q}", shape: OPENSEARCH },
	// Ecosia is left out deliberately: it answers 403 to requests from
	// Cloudflare worker IPs (bot detection), so it cannot be served from the
	// edge even though the endpoint itself is fine.
	// kagisuggest.com is the documented suggestions host (from their
	// opensearch.xml), not the main kagi.com API.
	kagi: { url: "https://kagisuggest.com/api/autosuggest?q={q}", shape: OPENSEARCH },
	qwant: { url: "https://api.qwant.com/v3/suggest/?q={q}&client=opensearch", shape: OPENSEARCH },
	startpage: { url: "https://www.startpage.com/osuggestions?q={q}", shape: OPENSEARCH },
	sp: { url: "https://www.startpage.com/osuggestions?q={q}", shape: OPENSEARCH },
};

export async function onRequestGet(context: { request: Request }): Promise<Response> {
	const url = new URL(context.request.url);
	const query = url.searchParams.get("q") ?? "";
	// Descriptions and favicons are on by default; "?rich=0" drops back to a
	// plain four-element response for clients that do not want the extra weight.
	const rich = url.searchParams.get("rich") !== "0";
	const trimmed = query.trim();

	// Both kinds of forwarding are off by default. Nothing about a query leaves
	// this function unless the user opted in through the suggest URL:
	//
	//   site_specific_forward=1   a bang followed by a space forwards the rest
	//                             to that service's own autocomplete
	//                             ("!gh react" -> GitHub's repo search).
	//   forwarder=<provider>      a plain query is forwarded to the named
	//                             engine ("cats" -> DuckDuckGo).
	const siteForward = url.searchParams.get("site_specific_forward") === "1";
	const forwarder = url.searchParams.get("forwarder");

	// A bang followed by a space. With site-specific forwarding on, the term
	// goes to the service the bang names; otherwise the bang completes but the
	// term is never sent anywhere.
	const bangTerm = parseBangTerm(trimmed);
	if (bangTerm) {
		if (!siteForward) return plainResponse(query, []);
		const completions = await forwardToBang(bangTerm.trigger, bangTerm.term);
		return plainResponse(query, completions.map((c) => `!${bangTerm.trigger} ${c}`));
	}

	// A plain query. Only forwarded when the user named a provider; otherwise
	// it is none of our business and gets no lookup.
	const bang = parsePartialBang(trimmed);
	if (!bang) {
		const target = forwarder ? FORWARD_ENGINES[forwarder] : undefined;
		if (target) {
			const completions = await forwardToUrl(target, trimmed);
			return plainResponse(query, completions);
		}
		return suggestionsResponse(query, [], [], rich);
	}

	const entries = suggestIndices(bang.partial);
	return suggestionsResponse(
		query,
		entries.map((i) => `${bang.prefix}!${triggers[i]}`),
		entries,
		rich,
	);
}

// Forward to one of the named engines for a plain query. Same failure model as
// forwardToBang: a dead or malformed upstream yields no suggestions.
async function forwardToUrl(
	target: { url: string; shape: string },
	term: string,
): Promise<string[]> {
	if (!term) return [];
	try {
		const res = await fetch(
			target.url.replace("{q}", encodeURIComponent(term)),
			{ headers: { "User-Agent": "unduckified-suggest/1.0" }, signal: AbortSignal.timeout(2500) },
		);
		if (!res.ok) return [];
		return extractCompletions(target.shape, await res.json()).slice(0, SUGGEST_LIMIT);
	} catch {
		return [];
	}
}
