#!/usr/bin/env node
// Cold-path wire bytes: every byte the browser downloads before the redirect
// fires, in a brand-new context. This is the number that gates the first search,
// which is not the same as a tool's total offline footprint — a tool that loads
// its catalog in shards pays only for the shard the query needs.
//
// Run: node bench/bytes-bench.mjs     (same env knobs as redirect-bench.mjs)
import { chromium } from "playwright";

const Q = process.env.Q || "%21gh%20test";
const TOOLS = {
	unduckified: (process.env.UNDUCK || "https://s.dunkirk.sh") + "/?q=" + Q,
	flashbang: (process.env.FLASH || "https://flashbang.tech") + "/?q=" + Q,
};
const DEST_HOST = process.env.DEST_HOST || "github.com";

async function measure(browser, url) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const client = await ctx.newCDPSession(page);
	await client.send("Network.enable");
	const started = new Map(); // requestId -> url
	const bytes = new Map(); // requestId -> encodedDataLength
	let stop = false;
	const done = new Promise((resolve) => {
		client.on("Network.requestWillBeSent", (e) => {
			let host;
			try { host = new URL(e.request.url).host; } catch { return; }
			if (host === DEST_HOST) { stop = true; resolve(); return; }
			if (!stop) started.set(e.requestId, e.request.url);
		});
		client.on("Network.loadingFinished", (e) => {
			if (started.has(e.requestId)) bytes.set(e.requestId, e.encodedDataLength);
		});
	});
	page.goto(url, { waitUntil: "commit" }).catch(() => {});
	await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
	await new Promise((r) => setTimeout(r, 400)); // let in-flight loadingFinished land
	await page.close();
	await ctx.close();
	const rows = [...started]
		.map(([id, u]) => [u, bytes.get(id) ?? 0])
		.filter(([, b]) => b > 0);
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
