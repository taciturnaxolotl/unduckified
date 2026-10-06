#!/usr/bin/env node
// Saved settings must survive a worker restart (issue #26).
//
// The worker holds the default bang and the custom bangs in memory and writes
// them to Cache Storage. A worker the browser has stopped loses the memory copy
// and has to read them back, and that is the path that broke: the worker used to
// decide whether a profile had settings by looking for a cookie, which the edge
// can see and a worker cannot. The browser attaches cookies after the fetch
// handler has already answered and never shows them to it, so every profile
// looked settings-free and every bare query went to DuckDuckGo.
//
// Run `bun run build` first, then `bun run check`.
//
// The built worker is served through Playwright route fulfillment, so nothing
// listens on a port and no request leaves the machine. Playwright cannot serve a
// worker's own fetches reliably, so the catalog is handed over with
// SEED_BANG_DATA, which is what the real page does on a cold start; the worker
// persists it, so the restarted worker reads it back out of Cache Storage
// exactly as it would in production. The catalog comes from public/, since the
// copy in dist/ is brotli-compressed for the CDN.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const ORIGIN = "https://unduck.test";
const SW = readFileSync("dist/sw.js");
const BIN = readFileSync("public/bangs.bin");

const PAGE = `<!doctype html><title>boot</title><script>
const send = (msg, transfer) => navigator.serviceWorker.controller.postMessage(msg, transfer || []);
navigator.serviceWorker.register("/sw.js")
  .then(() => navigator.serviceWorker.ready)
  .then(async () => {
    const buf = await fetch("/bangs.bin").then((r) => r.arrayBuffer());
    send({ type: "SEED_BANG_DATA", buffer: buf }, [buf]);
    document.title = "ready";
  })
  .catch((err) => { document.title = "error: " + err.message; });
window.setDefault = (t) => send({ type: "SET_DEFAULT_BANG", trigger: t });
window.setCustom = (bangs) => send({ type: "UPDATE_CUSTOM_BANGS", bangs });
</script>`;

const browser = await chromium.launch();
const ctx = await browser.newContext();

// Where the worker sent us. Every request off this origin is answered locally.
let offsite = null;
await ctx.route("**/*", (route) => {
	const u = new URL(route.request().url());
	if (u.origin !== ORIGIN) {
		offsite ??= u.toString();
		return route.fulfill({ status: 200, contentType: "text/html", body: "<title>offsite</title>" });
	}
	if (u.pathname === "/sw.js")
		return route.fulfill({ status: 200, contentType: "text/javascript", body: SW });
	if (u.pathname === "/bangs.bin")
		return route.fulfill({ status: 200, contentType: "application/octet-stream", body: BIN });
	return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
});
// The real client raises this when settings exist, and the edge reads it. The
// worker must reach the same answer without it.
await ctx.addCookies([{ name: "unduck-settings", value: "1", url: `${ORIGIN}/` }]);

const page = await ctx.newPage();
// A page-level CDP session sees the workers in this context; a browser-level one
// does not, and stopping nothing would quietly measure the warm path instead.
const cdp = await ctx.newCDPSession(page);
const running = new Set();
cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
	for (const v of versions) {
		if (v.runningStatus === "running") running.add(v.versionId);
		else running.delete(v.versionId);
	}
});
await cdp.send("ServiceWorker.enable");
await page.goto(`${ORIGIN}/`);
await page.waitForFunction("document.title !== 'boot'");
const title = await page.title();
if (title !== "ready") throw new Error(`worker never took control (${title})`);

await page.evaluate(`setDefault("g")`);
await page.evaluate(`setCustom({ zz: { u: "https://zz.example/s?q={{{s}}}" } })`);
await page.waitForTimeout(300); // let the cache writes land

async function search(q) {
	offsite = null;
	await page.goto(`${ORIGIN}/?q=${encodeURIComponent(q)}`).catch(() => {});
	return offsite;
}

const got = {
	"warm, bare query": await search("hello"),
	"warm, explicit bang": await search("!ddg hello"),
	// zz is also a builtin (zerozero.pt), so this checks that a custom bang
	// shadows the catalog rather than losing to it.
	"warm, custom bang": await search("!zz hello"),
};

// The search counter holds the worker alive on a two second timer, so let that
// drain or the stop is refused and this silently measures the warm path again.
await page.waitForTimeout(2_500);
if (running.size === 0) throw new Error("no running worker to stop");
for (let attempt = 0; attempt < 10 && running.size > 0; attempt++) {
	for (const versionId of running) await cdp.send("ServiceWorker.stopWorker", { versionId });
	await page.waitForTimeout(300);
}
if (running.size !== 0) throw new Error("worker would not stop; this would measure the warm path");

got["restarted, bare query"] = await search("hello");
got["restarted, custom bang"] = await search("!zz hello");

await browser.close();

const want = {
	"warm, bare query": "google.",
	"warm, explicit bang": "duckduckgo.",
	"warm, custom bang": "zz.example",
	"restarted, bare query": "google.",
	"restarted, custom bang": "zz.example",
};
let failed = 0;
for (const [name, expected] of Object.entries(want)) {
	const ok = got[name]?.includes(expected);
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${got[name] ?? "not redirected"}`);
}
console.log(failed === 0 ? "\nall settings honoured" : `\n${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
