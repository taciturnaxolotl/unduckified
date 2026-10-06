#!/usr/bin/env node
// Cold-path wire bytes: every byte the browser downloads before the redirect
// fires, in a brand-new context. This is the number that gates the first search,
// which is not the same as a tool's total offline footprint — a tool that loads
// its catalog in shards pays only for the shard the query needs.
//
// Two things make the raw CDP total lie, and both are corrected here.
//
// A server-side redirect keeps the same requestId across the hop, so its
// loadingFinished total would bill the destination's page to the tool. The
// redirect response carries its own size, which is what gets counted instead.
//
// A resource advertised in an HTTP 103 Early Hints response is served from the
// preload cache, and Chrome reports encodedDataLength 0 for that hit while still
// delivering a decoded body. Anything still in flight when the redirect fires is
// lost the same way. Summing encodedDataLength therefore scores those modules as
// free and a b>0 filter drops them, undercounting any tool that preloads its cold
// resolver. We recover the real wire size with an independent brotli refetch and
// mark it [refetch:br].
//
// Run: node bench/bytes-bench.mjs     (same env knobs as redirect-bench.mjs)
import https from "node:https";
import { chromium } from "playwright";

const Q = process.env.Q || "%21gh%20test";
const TOOLS = {
	unduckified: (process.env.UNDUCK || "https://s.dunkirk.sh") + "/?q=" + Q,
	flashbang: (process.env.FLASH || "https://flashbang.tech") + "/?q=" + Q,
};
const DEST_HOST = process.env.DEST_HOST || "github.com";

// Compressed transfer size of a single resource, measured off its own request
// so a preload-cache hit (encodedDataLength 0 in CDP) is still accounted for.
// node:https does not decode the body, so summing raw chunks is the wire size.
function wireSize(url) {
	return new Promise((resolve) => {
		const req = https.get(url, { headers: { "accept-encoding": "br, gzip" } }, (res) => {
			let n = 0;
			res.on("data", (c) => { n += c.length; });
			res.on("end", () => resolve(n));
			res.on("error", () => resolve(0));
		});
		req.on("error", () => resolve(0));
		req.setTimeout(10_000, () => { req.destroy(); resolve(0); });
	});
}

async function measure(browser, url) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const client = await ctx.newCDPSession(page);
	await client.send("Network.enable");
	const started = new Map(); // requestId -> url
	const bytes = new Map(); // requestId -> encodedDataLength
	const sealed = new Set(); // ids whose size came from a redirect hop
	let stop = false;
	const done = new Promise((resolve) => {
		client.on("Network.requestWillBeSent", (e) => {
			let host;
			try { host = new URL(e.request.url).host; } catch { return; }
			// A server-side redirect keeps the same requestId across the hop, so
			// its loadingFinished total would include the destination's page.
			// The redirect response carries its own size; take that and stop.
			if (e.redirectResponse && started.has(e.requestId)) {
				bytes.set(e.requestId, e.redirectResponse.encodedDataLength);
				sealed.add(e.requestId);
				if (host === DEST_HOST) { stop = true; resolve(); return; }
				return;
			}
			if (host === DEST_HOST) { stop = true; resolve(); return; }
			if (!stop) started.set(e.requestId, e.request.url);
		});
		client.on("Network.loadingFinished", (e) => {
			// A sealed id already had its size taken from a redirect hop.
			if (started.has(e.requestId) && !sealed.has(e.requestId)) {
				bytes.set(e.requestId, e.encodedDataLength);
			}
		});
	});
	page.goto(url, { waitUntil: "commit" }).catch(() => {});
	await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
	await new Promise((r) => setTimeout(r, 400)); // let in-flight loadingFinished land
	await page.close();
	await ctx.close();

	// Every request the browser made before the redirect, deduped by URL. A zero
	// means the browser never billed it — a preload-cache hit or one still in
	// flight at stop — so recover its wire size with an independent refetch.
	const rows = [];
	const seen = new Set();
	for (const [, u] of started) {
		if (seen.has(u)) continue;
		seen.add(u);
		let b = 0;
		for (const [id, iu] of started) if (iu === u) b = Math.max(b, bytes.get(id) ?? 0);
		let label = u;
		if (b === 0) { b = await wireSize(u); label = `${u}  [refetch:br]`; }
		if (b > 0) rows.push([label, b]);
	}
	const total = rows.reduce((s, [, b]) => s + b, 0);
	return { total, rows };
}

const browser = await chromium.launch({ headless: true });
for (const [name, url] of Object.entries(TOOLS)) {
	const { total, rows } = await measure(browser, url);
	console.log(`\n${name}  q=${decodeURIComponent(Q)}  total ${(total / 1024).toFixed(1)} KiB`);
	for (const [u, b] of rows.sort((a, c) => c[1] - a[1]))
		console.log(`  ${(b / 1024).toFixed(1).padStart(7)} KiB  ${u}`);
}
await browser.close();
