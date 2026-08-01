// Refreshes the DuckDuckGo relevance ranks used to order bang suggestions.
//
// Kagi (our bang source) does not publish popularity data, so we borrow
// DuckDuckGo's usage counts purely as a ranking signal and join them by
// trigger name. Only nonzero ranks are kept to save space.
//
// The result is committed to the repo so builds stay offline-friendly and
// reproducible. Run this occasionally to pick up shifts in bang popularity.

const DDG_SOURCE = "https://duckduckgo.com/bang.js";
const OUT = "src/bangs/ddg-ranks.json";

const res = await fetch(DDG_SOURCE);
if (!res.ok) throw new Error(`DDG fetch failed: ${res.status}`);
const entries: Array<{ t?: string; r?: number }> = await res.json();

const ranks: Record<string, number> = {};
for (const entry of entries) {
	if (entry.t && typeof entry.r === "number" && entry.r > 0) {
		ranks[entry.t] = entry.r;
	}
}

if (Object.keys(ranks).length === 0) {
	throw new Error("DDG returned no ranks; refusing to overwrite cache");
}

await Bun.write(OUT, JSON.stringify(ranks));
console.log(`Wrote ${OUT}: ${Object.keys(ranks).length} ranked triggers`);
