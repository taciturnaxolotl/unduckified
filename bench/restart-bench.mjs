#!/usr/bin/env node
// Worker-restart benchmark — the third lifecycle state, between warm and cold.
//
// The Service Worker is installed and controlling, but the browser has stopped
// it, so the redirect pays worker startup on top of the local lookup. This is
// the normal state for a search engine you use a few times a day. We force it
// with CDP ServiceWorker.stopWorker before every sample. The session must be
// page-scoped: a browser-level one does not see the workers in a Playwright
// context, and stopping nothing would silently measure the warm path instead.
//
// Same pairing and statistics as redirect-bench.mjs; same env knobs.
// Run: node bench/restart-bench.mjs [rounds]
import { chromium } from "playwright";

const Q = process.env.Q || "%21gh%20test";
const TOOLS = {
	unduckified: (process.env.UNDUCK || "https://s.dunkirk.sh") + "/?q=" + Q,
	flashbang: (process.env.FLASH || "https://flashbang.tech") + "/?q=" + Q,
};
const DEST_HOST = "github.com";
const ROUNDS = Number(process.argv[2] || 30);
const WARMUP = 3;

const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => { const s = sorted(a); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function bootCI(a, stat, B = 10_000) {
	const out = []; const n = a.length;
	for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < n; i++) s.push(a[(Math.random()*n)|0]); out.push(stat(s)); }
	const s = sorted(out); return [s[Math.floor(0.025*B)], s[Math.floor(0.975*B)]];
}
function permTest(diffs, B = 50_000) {
	const obs = Math.abs(mean(diffs)); let ge = 0;
	for (let b = 0; b < B; b++) { let s = 0; for (const d of diffs) s += Math.random() < 0.5 ? d : -d; if (Math.abs(s/diffs.length) >= obs - 1e-9) ge++; }
	return (ge + 1) / (B + 1);
}

async function timeRedirect(ctx, url) {
	const page = await ctx.newPage();
	const client = await ctx.newCDPSession(page);
	await client.send("Network.enable");
	let t0 = null, t1 = null;
	const done = new Promise((resolve) => {
		client.on("Network.requestWillBeSent", (e) => {
			let host; try { host = new URL(e.request.url).host; } catch { return; }
			if (t0 === null && url.includes(host)) t0 = e.wallTime;
			if (t1 === null && host === DEST_HOST) { t1 = e.wallTime; resolve(); }
		});
	});
	page.goto(url, { waitUntil: "commit" }).catch(() => {});
	await Promise.race([done, new Promise((_, rej) => setTimeout(rej, 15_000))]).catch(() => {});
	await page.close();
	return t0 !== null && t1 !== null ? (t1 - t0) * 1000 : null;
}

async function prime(browser, url) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto(new URL(url).origin + "/", { waitUntil: "load" }).catch(() => {});
	const controlled = await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 12_000 }).then(() => true).catch(() => false);
	// Keep this page alive as the control channel: a page-level CDP session sees
	// the workers registered in *this* context, which a browser-level one does not.
	const sw = await ctx.newCDPSession(page);
	await sw.send("ServiceWorker.enable");
	const versions = new Set();
	sw.on("ServiceWorker.workerVersionUpdated", (e) => {
		for (const v of e.versions) {
			if (v.runningStatus === "running") versions.add(v.versionId);
			else versions.delete(v.versionId);
		}
	});
	// page stays open on purpose: closing it would take the CDP session with it.
	return { ctx, sw, versions, controlled };
}

async function main() {
	const browser = await chromium.launch({ headless: true });
	const st = {};
	for (const [name, url] of Object.entries(TOOLS)) {
		st[name] = await prime(browser, url);
		if (!st[name].controlled) console.warn(`! ${name}: SW never took control`);
	}
	const [A, B] = Object.keys(TOOLS);
	const res = { [A]: [], [B]: [] };
	const diffs = [];
	let stoppedNothing = 0;
	for (let r = 0; r < ROUNDS + WARMUP; r++) {
		const order = Math.random() < 0.5 ? [A, B] : [B, A];
		const got = {};
		for (const name of order) {
			const before = [...st[name].versions];
			for (const versionId of before) await st[name].sw.send("ServiceWorker.stopWorker", { versionId }).catch(() => {});
			await st[name].sw.send("ServiceWorker.stopAllWorkers").catch(() => {});
			await new Promise((r) => setTimeout(r, 300));
			if (!before.length) stoppedNothing++;
			got[name] = await timeRedirect(st[name].ctx, TOOLS[name]);
		}
		if (r >= WARMUP && got[A] !== null && got[B] !== null) {
			res[A].push(got[A]); res[B].push(got[B]); diffs.push(got[A] - got[B]);
		}
		process.stdout.write(`restart ${Math.max(0, r-WARMUP+1)}/${ROUNDS}  ${A} ${got[A]?.toFixed(2)}  ${B} ${got[B]?.toFixed(2)}      \r`);
	}
	console.log(`\n\n=== RESTART — paired, ${diffs.length}/${ROUNDS} rounds, q=${decodeURIComponent(Q)} ===`);
	for (const name of [A, B]) {
		const ci = bootCI(res[name], median);
		console.log(`${name.padEnd(12)} median ${median(res[name]).toFixed(2)}ms  95% CI [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]`);
	}
	const dCI = bootCI(diffs, mean);
	console.log(`paired diff (${A} - ${B}): mean ${mean(diffs).toFixed(2)}ms  95% CI [${dCI[0].toFixed(2)}, ${dCI[1].toFixed(2)}]  ${A} faster ${diffs.filter(d=>d<0).length}/${diffs.length}  perm p=${permTest(diffs).toFixed(4)}`);
	if (stoppedNothing) console.log(`! ${stoppedNothing} stop attempts saw no running worker`);
	await browser.close();
}
main();
