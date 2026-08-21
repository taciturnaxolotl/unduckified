# Benchmarking unduckified

This documents how the benchmark data is derived. This is a shockingly hard system to measure since the actual work done is so miniscule compared to network latency and browser noise.

You can measure this yourself with [`bench/redirect-bench.mjs`](bench/redirect-bench.mjs).

## What we measure, and why

Four things matter to a user pressing Enter in the address bar:

1. **Warm redirect latency**: once the Service Worker is
   installed how long till it redirects. This is most of what a user experiences.
2. **Restart redirect latency**: the worker is installed but the browser has stopped it, so it has to boot before it can answer. This is the honest steady state if you search a few times a day rather than a few times a minute.
3. **Cold redirect latency**: a brand-new profile's very first search which has to download the code and bang catalog.
4. **Bytes on the wire**: what is transfered to your browser (compressed)

Everything is timed address bar to redirect and stops at the request to the destination rather than its response since we are measuring the tool's overhead rather than how fast external sites are.

## How a sample is taken

Using Playwright with headless Chrome and a raw CDP session, we read
`Network.requestWillBeSent` wallTimes for two events:

- **t0**: the tool's own navigation-document request (pressing Enter).
- **t1**: the first request to the destination origin (e.g. `github.com`).

The sample is `t1 - t0`. The script measures **both states the same way**, so
they're directly comparable — the only difference is the browser context:

- **Cold**: a brand-new context per sample: no HTTP cache, no Service Worker, no IndexedDB. This is the only state the edge redirect (`functions/index.ts`) answers, so a cold sample times one round trip rather than a page load followed by a catalog download.
- **Warm**: a context whose Service Worker is already installed and controlling,reused across samples. The script primes it first (visit the origin root, then waiting until `navigator.serviceWorker.controller` is set) and double checks the service worker took control.
- **Restart**: the same primed context, but CDP `ServiceWorker.stopWorker` kills the worker before every sample so it has to start again. The CDP session has to be page-scoped; a browser-level one cannot see the workers inside a Playwright context, and stopping nothing would quietly hand you warm numbers again.

## Pairing

Network latency to each tool's edge drifts second to second, and a single slow
moment (a GC pause, a Wi-Fi retransmit, a busy CDN PoP) can add ±80 ms to a
sample. Two SW tools whose true redirect logic differs by ~15 ms have wire
latencies that overlap almost completely once that noise is in play.

The proper fix is a **paired protocol**:

- In each round, measure **both tools back to back**, in **randomized order**
  (so neither always runs first and benefits from a warmed connection).
- Analyze the **per-round difference** (A − B), not the two distributions
  separately. A slow stutter now hits both tools in the same round and cancels the difference instead of inflating each tool's variance.
- Discard the first few rounds as warm-up (cold DNS/TLS).

## The statistics

For each tool: median with a **percentile bootstrap 95% CI** (10k resamples).

For the paired difference, three complementary readings:

- **Bootstrap 95% CI of the mean difference**: if it excludes 0, the tools really differ.
- **Win rate**: the fraction of rounds one tool was faster. A real effect shows up as a lopsided rate (e.g. 96/120) even when individual samples are noisy.
- **Sign-flip permutation test**: under the null the sign of each paired difference is exchangeable, so we randomly flip signs 50k times and see how often the resampled mean matches or beats the observed one. This gives a two-sided p-value with no distributional assumptions.

All three are required to agree.

## Running it

```bash
npm i -D playwright            # or: bun add -d playwright
npx playwright install chromium
node bench/redirect-bench.mjs  # optional arg: number of paired rounds (default 60)
node bench/restart-bench.mjs   # the stopped-worker state
node bench/bytes-bench.mjs     # cold-path bytes, per tool
```

`Q`, `UNDUCK`, `FLASH`, `NAME_B` and `DEST_HOST` point the scripts at other deployments, another builtin bang, or another tool entirely:

```bash
Q="%21github%20test" node bench/redirect-bench.mjs 30
NAME_B=rebang FLASH=https://rebang.online node bench/redirect-bench.mjs 20
``` It runs the warm phase then the cold phase, each printing per-tool medians + CIs, the paired difference with its CI, the win rate, and the permutation p-value.

## Measuring bytes on the wire

Two different numbers hide in this column, so keep them apart:

- **Cold-path bytes** are what the browser must download before the redirect can fire. `bench/bytes-bench.mjs` sums CDP `encodedDataLength` for every request that starts before the first request to the destination. unduckified pays its whole catalog here, the same 197.6 KiB whatever you search for, because the lookup needs the catalog. A tool that shards its catalog pays only for the shard the query routes to, so its number moves with the query.
- **Total offline footprint** is everything a tool eventually caches. It does not block any redirect, and for unduckified it is the same 197.6 KiB, which is why one column used to be able to carry both.

A single file's wire size needs no browser at all:

```bash
# compressed transfer size
curl -s -H 'Accept-Encoding: br, gzip' -o /dev/null -w '%{size_download}\n' \
  https://s.dunkirk.sh/bangs.bin

# decoded size + the encoding type
curl -s --compressed -o /tmp/x -w 'decoded=%{size_download} type=%{content_type}\n' \
  https://s.dunkirk.sh/bangs.bin
```
