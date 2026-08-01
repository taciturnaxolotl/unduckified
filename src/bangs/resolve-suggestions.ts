// Builds the per-bang suggestion endpoint map.
//
// When a bang resolves, the suggest function forwards the rest of the query to
// that service's own autocomplete API (see functions/suggest.ts). But no public
// dataset says which bangs even have such an API, let alone where it lives or
// what shape it returns. This script produces that map.
//
// Two sources, because the endpoints are not discoverable from the catalog:
//
//   1. A curated list for the well-known services (github, npm, youtube...),
//      where the suggestion URL and response shape are simply things you know.
//   2. A live probe for MediaWiki sites. Wikis are a large share of the top
//      bangs and all answer the same canonical opensearch endpoint, so probing
//      `api.php?action=opensearch` tells us which domains really are MediaWiki
//      without hand-listing every fandom wiki.
//
// The result is committed (src/bangs/suggest-endpoints.json) so builds stay
// offline and reproducible. Run occasionally, like fetch-ranks.ts.

import { readFileSync } from "fs";

type Bang = { t?: string; s: string; u: string; d: string; ts?: string[] };

const OUT = "src/bangs/suggest-endpoints.json";
const CONCURRENCY = 12;
const TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// Curated endpoints.
//
// Each entry maps one or more triggers to a suggestion URL template ({q} is
// the query placeholder) and the shape of the JSON it returns, which tells the
// suggest function how to pull the completion strings out of the payload.
// These are the services where the endpoint is known knowledge, not something
// a probe can find.
// ---------------------------------------------------------------------------

type Shape =
	// [query, [completions], ...] — MediaWiki opensearch, Google suggest.
	| "opensearch"
	// { suggestions: [{ value }] } — Amazon.
	| "amazon"
	// [{ package: { name } }] — npms.io.
	| "npms"
	// { data: { children: [{ data: { display_name } }] } } — Reddit.
	| "reddit"
	// { hits: [{ title }] } — Algolia (Hacker News).
	| "algolia"
	// { crates: [{ name }] } — crates.io.
	| "crates";

interface Endpoint {
	url: string;
	shape: Shape;
	/** Header keys worth sending (some APIs reject bare fetches). */
	headers?: Record<string, string>;
}

const CURATED: Record<string, Endpoint> = {
	github: {
		url: "https://api.github.com/search/repositories?q={q}&per_page=8",
		shape: "algolia", // { items/hits: [...] }; github uses full_name below
	},
	npm: {
		url: "https://api.npms.io/v2/search/suggestions?q={q}&size=8",
		shape: "npms",
	},
	youtube: {
		url: "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q}",
		shape: "opensearch",
	},
	yt: {
		url: "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q}",
		shape: "opensearch",
	},
	// The wikipedia.org domain is a redirect shell, not a content wiki, so the
	// probe finds no API there. English Wikipedia is the service these triggers
	// actually mean, so point them at it directly.
	wikipedia: {
		url: "https://en.wikipedia.org/w/api.php?action=opensearch&search={q}&format=json&limit=8",
		shape: "opensearch",
	},
	w: {
		url: "https://en.wikipedia.org/w/api.php?action=opensearch&search={q}&format=json&limit=8",
		shape: "opensearch",
	},
	wiki: {
		url: "https://en.wikipedia.org/w/api.php?action=opensearch&search={q}&format=json&limit=8",
		shape: "opensearch",
	},
	amazon: {
		url: "https://completion.amazon.com/api/2017/suggestions?limit=8&prefix={q}&suggestion-type=KEYWORD&mid=ATVPDKIKX0DER&alias=aps",
		shape: "amazon",
	},
	a: {
		url: "https://completion.amazon.com/api/2017/suggestions?limit=8&prefix={q}&suggestion-type=KEYWORD&mid=ATVPDKIKX0DER&alias=aps",
		shape: "amazon",
	},
	reddit: {
		url: "https://www.reddit.com/subreddits/search.json?q={q}&limit=8",
		shape: "reddit",
		headers: { "User-Agent": "unduckified-suggest/1.0" },
	},
	hn: {
		url: "https://hn.algolia.com/api/v1/search?query={q}&hitsPerPage=8",
		shape: "algolia",
	},
	crates: {
		url: "https://crates.io/api/v1/crates?q={q}&per_page=8",
		shape: "crates",
	},
};

// ---------------------------------------------------------------------------
// MediaWiki probe.
//
// Every MediaWiki site answers the same opensearch endpoint. Probing it is a
// reliable detector: real wikis return the 4-element array, and the lookalikes
// (rust doc, rottentomatoes, namu) return a 404 HTML page. So we only probe
// domains that already smell like wikis, to avoid hundreds of wasted requests.
// ---------------------------------------------------------------------------

const WIKI_RE = /\.wiki$|\.wiki\.|wiki\.|wikipedia|wiktionary|wikimedia|fandom\.com|wikia\.com|wiki\.gg/;

// MediaWiki puts api.php at a location that varies by site: most wikis serve
// it from the root (/api.php), but the Wikipedia family and many others nest
// it (/w/api.php). The probe below tries the candidates and remembers which
// one answered.
function mediaWikiEndpoint(domain: string, path: string): Endpoint {
	return {
		url: `https://${domain}${path}api.php?action=opensearch&search={q}&format=json&limit=8`,
		shape: "opensearch",
	};
}

// Probes the candidate api.php locations for a domain and returns the path
// that answers, or null. Root first, then /w/, since those cover the field.
async function probeMediaWiki(domain: string): Promise<string | null> {
	for (const path of ["/", "/w/"]) {
		try {
			const res = await fetch(
				`https://${domain}${path}api.php?action=opensearch&search=mw&format=json&limit=1`,
				{ signal: AbortSignal.timeout(TIMEOUT_MS) },
			);
			if (!res.ok) continue;
			const body: unknown = await res.json();
			if (Array.isArray(body) && body.length >= 2 && Array.isArray(body[1])) {
				return path;
			}
		} catch {
			// Fall through to the next candidate path.
		}
	}
	return null;
}

// ---------------------------------------------------------------------------

const raw: Bang[] = JSON.parse(
	readFileSync("src/bangs/bangs.json", "utf-8"),
);

// Triggers for each domain, so one probed domain covers every alias.
const triggersByDomain = new Map<string, string[]>();
for (const b of raw) {
	if (!b.t || !b.u || !b.s || !b.d) continue;
	const list = triggersByDomain.get(b.d) ?? [];
	if (!list.includes(b.t)) list.push(b.t);
	triggersByDomain.set(b.d, list);
	if (b.ts) {
		for (const alias of b.ts) if (!list.includes(alias)) list.push(alias);
	}
}

const result: Record<string, Endpoint> = {};

// Curated entries land first and win over anything the probe would find.
let curatedCount = 0;
for (const [trigger, endpoint] of Object.entries(CURATED)) {
	result[trigger] = endpoint;
	curatedCount++;
}

// A curated trigger usually names only one of a service's forms ("github" but
// not "gh"). The other aliases point at the same domain and mean the same
// service, so fan each curated endpoint out to every trigger that shares its
// domain. This is what makes !gh and !git forward too, not just !github.
const domainByTrigger = new Map<string, string>();
for (const b of raw) {
	if (!b.t || !b.d) continue;
	domainByTrigger.set(b.t, b.d);
	if (b.ts) for (const alias of b.ts) domainByTrigger.set(alias, b.d);
}
for (const [trigger, endpoint] of Object.entries(CURATED)) {
	const domain = domainByTrigger.get(trigger);
	if (!domain) continue;
	for (const alias of triggersByDomain.get(domain) ?? []) {
		if (!(alias in result)) result[alias] = endpoint;
	}
}

// Probe unique wiki-ish domains, then fan the working ones out to their triggers.
// The path that answers varies by site (root for most, /w/ for Wikipedia), so
// it comes back from the probe rather than being assumed.
const wikiDomains = [...triggersByDomain.keys()].filter((d) => WIKI_RE.test(d));
console.log(
	`curated endpoints: ${curatedCount}; probing ${wikiDomains.length} wiki-ish domains`,
);

let working = 0;
for (let i = 0; i < wikiDomains.length; i += CONCURRENCY) {
	const batch = wikiDomains.slice(i, i + CONCURRENCY);
	const verdicts = await Promise.all(batch.map(probeMediaWiki));
	for (let j = 0; j < batch.length; j++) {
		const path = verdicts[j];
		if (path === null) continue;
		working++;
		const endpoint = mediaWikiEndpoint(batch[j], path);
		for (const trigger of triggersByDomain.get(batch[j]) ?? []) {
			if (!(trigger in result)) result[trigger] = endpoint;
		}
	}
}

if (Object.keys(result).length === 0) {
	throw new Error("no endpoints resolved; refusing to overwrite cache");
}

await Bun.write(OUT, JSON.stringify(result));
console.log(
	`MediaWiki working: ${working}/${wikiDomains.length}\nWrote ${OUT}: ${Object.keys(result).length} trigger endpoints`,
);
