#!/usr/bin/env node
// Redirect-latency benchmark — paired warm + cold, for comparing bang tools.
//
// Measures the span from a tool's own document request to the first request to
// the destination origin (address bar -> redirect commit), using CDP wallTime:
//   t0 = the tool's navigation-document request
//   t1 = the first request to the destination origin (e.g. github.com)
//
// Two states, both measured the same way so they're directly comparable:
//   COLD — a brand-new browser context per sample: no HTTP cache, no Service
//          Worker, no IndexedDB. The first-search-after-install tax.
//   WARM — a context whose Service Worker is already installed and controlling,
//          reused across samples. Steady state. Here t0->t1 is the worker's
//          local intercept + redirect dispatch (no network to the tool), so warm
//          numbers are much smaller than cold and dominated by SW dispatch.
//
// Both are *paired*: each round measures both tools back to back in randomized
// order, and we analyze the per-round difference (A - B). Pairing cancels shared
// drift — a slow moment hits both tools in the same round, so it cancels in the
// difference instead of inflating each tool's variance. An unpaired comparison
// of 20 medians could not tell two SW tools ~15 ms apart; 60 paired rounds with
// a permutation test resolved it at p < 0.001. See BENCHMARK.md.
//
// Requires Playwright:  npm i -D playwright   (then: npx playwright install chromium)
// Run:                  node bench/redirect-bench.mjs [rounds]
// Env:                  Q, UNDUCK, FLASH, NAME_B, DEST_HOST — point it at other
//                       deployments, another builtin bang, or another tool
//                       (e.g. NAME_B=rebang FLASH=https://rebang.online).
import { chromium } from "playwright";

// The tools to compare, each pointed at the same builtin bang, and the
// destination origin that bang resolves to.
const Q = process.env.Q || "%21gh%20test";
const TOOLS = {
	unduckified: (process.env.UNDUCK || "https://s.dunkirk.sh") + "/?q=" + Q,
	[process.env.NAME_B || "flashbang"]: (process.env.FLASH || "https://flashbang.tech") + "/?q=" + Q,
};
const DEST_HOST = process.env.DEST_HOST || "github.com";
const ROUNDS = Number(process.argv[2] || 60);
const WARMUP = 3; // discarded: first hits pay cold DNS/TLS that later ones don't
const PER_SAMPLE_TIMEOUT_MS = 15_000;

// ---- statistics -----------------------------------------------------------
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => {
	const s = sorted(a);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const quantile = (a, q) => {
	const s = sorted(a);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const sd = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
// Percentile bootstrap 95% CI for an arbitrary statistic.
function bootCI(a, stat, B = 10_000) {
	const out = [];
	const n = a.length;
	for (let b = 0; b < B; b++) {
		const s = [];
		for (let i = 0; i < n; i++) s.push(a[(Math.random() * n) | 0]);
		out.push(stat(s));
	}
	const s = sorted(out);
	return [s[Math.floor(0.025 * B)], s[Math.floor(0.975 * B)]];
}
// Two-sided sign-flip permutation test on the mean paired difference.
function permTest(diffs, B = 50_000) {
	const obs = Math.abs(mean(diffs));
	let ge = 0;
	for (let b = 0; b < B; b++) {
		let s = 0;
		for (const d of diffs) s += Math.random() < 0.5 ? d : -d;
		if (Math.abs(s / diffs.length) >= obs - 1e-9) ge++;
	}
	return (ge + 1) / (B + 1);
}

// ---- measurement ----------------------------------------------------------
// Time one navigation in the given context: t0 = the tool's own document
// request, t1 = the first request to the destination origin.
async function timeRedirect(ctx, url) {
	const page = await ctx.newPage();
	const client = await ctx.newCDPSession(page);
	await client.send("Network.enable");
	let t0 = null;
	let t1 = null;
	const done = new Promise((resolve) => {
		client.on("Network.requestWillBeSent", (e) => {
			let host;
			try {
				host = new URL(e.request.url).host;
			} catch {
				return;
			}
			if (t0 === null && url.includes(host)) t0 = e.wallTime;
			if (t1 === null && host === DEST_HOST) {
				t1 = e.wallTime;
				resolve();
			}
		});
	});
	page.goto(url, { waitUntil: "commit" }).catch(() => {});
	try {
		await Promise.race([
			done,
			new Promise((_, rej) => setTimeout(() => rej(), PER_SAMPLE_TIMEOUT_MS)),
		]);
	} catch {}
	await page.close();
	return t0 !== null && t1 !== null ? (t1 - t0) * 1000 : null; // ms
}

// A fresh, throwaway context per sample: genuinely cold.
async function coldSample(browser, url) {
	const ctx = await browser.newContext();
	const ms = await timeRedirect(ctx, url);
	await ctx.close();
	return ms;
}

// A persistent context with the tool's Service Worker installed and controlling,
// so later navigations are intercepted locally (the warm path). Verifies the
// worker actually took control — otherwise a "warm" sample would silently be a
// cold one and the numbers would be meaningless.
async function primeWarm(browser, url) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	// Visit the origin root (no query) so the SW installs without redirecting
	// away, then wait until it actually controls the page.
	await page
		.goto(new URL(url).origin + "/", { waitUntil: "load" })
		.catch(() => {});
	const controlled = await page
		.waitForFunction(() => navigator.serviceWorker?.controller, null, {
			timeout: 12_000,
		})
		.then(() => true)
		.catch(() => false);
	await page.close();
	return { ctx, controlled };
}

// ---- run one paired state (warm or cold) ----------------------------------
async function runPaired(label, take) {
	const [A, B] = Object.keys(TOOLS);
	const res = { [A]: [], [B]: [] };
	const diffs = [];
	for (let r = 0; r < ROUNDS + WARMUP; r++) {
		const order = Math.random() < 0.5 ? [A, B] : [B, A];
		const got = {};
		for (const name of order) got[name] = await take(name);
		if (r >= WARMUP && got[A] !== null && got[B] !== null) {
			res[A].push(got[A]);
			res[B].push(got[B]);
			diffs.push(got[A] - got[B]);
		}
		process.stdout.write(
			`${label} ${Math.max(0, r - WARMUP + 1)}/${ROUNDS}  ${A} ${got[A]?.toFixed(1)}  ${B} ${got[B]?.toFixed(1)}      \r`,
		);
	}

	console.log(`\n\n=== ${label.toUpperCase()} — paired, ${diffs.length}/${ROUNDS} rounds ===`);
	for (const name of [A, B]) {
		const a = res[name];
		if (!a.length) {
			console.log(`${name.padEnd(12)} no samples`);
			continue;
		}
		const ci = bootCI(a, median);
		console.log(
			`${name.padEnd(12)} median ${median(a).toFixed(2)}ms  95% CI [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]  mean ${mean(a).toFixed(2)}  sd ${sd(a).toFixed(2)}  p90 ${quantile(a, 0.9).toFixed(2)}`,
		);
	}
	if (diffs.length) {
		const dCI = bootCI(diffs, mean);
		const wins = diffs.filter((d) => d < 0).length;
		const p = permTest(diffs);
		console.log(
			`paired diff (${A} - ${B}): mean ${mean(diffs).toFixed(2)}ms  95% CI [${dCI[0].toFixed(2)}, ${dCI[1].toFixed(2)}]  ${A} faster ${wins}/${diffs.length}  perm p=${p.toFixed(4)}`,
		);
		console.log(
			`  => ${dCI[0] <= 0 && dCI[1] >= 0 ? "indistinguishable (95% CI includes 0)" : `${mean(diffs) < 0 ? A : B} is faster`}`,
		);
	}
}

async function main() {
	if (Object.keys(TOOLS).length !== 2) {
		throw new Error("This paired benchmark compares exactly two tools.");
	}
	const browser = await chromium.launch({ headless: true });

	// WARM: one persistent, SW-primed context per tool, reused across samples.
	const warm = {};
	for (const [name, url] of Object.entries(TOOLS)) {
		warm[name] = await primeWarm(browser, url);
		if (!warm[name].controlled) {
			console.warn(`! ${name}: Service Worker never took control — warm numbers will be unreliable`);
		}
	}
	await runPaired("warm", (name) => timeRedirect(warm[name].ctx, TOOLS[name]));
	for (const w of Object.values(warm)) await w.ctx.close();

	// COLD: a throwaway context per sample.
	await runPaired("cold", (name) => coldSample(browser, TOOLS[name]));

	await browser.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
