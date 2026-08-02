# Benchmarking unduckified

This documents how the benchmark data is derived. This is a shockingly hard system to measure since the actual work done is so miniscule compared to network latency and browser noise.

You can measure this yourself with [`bench/redirect-bench.mjs`](bench/redirect-bench.mjs).

## What we measure, and why

Three things matter to a user pressing Enter in the address bar:

1. **Warm redirect latency**: once the Service Worker is
   installed how long till it redirects. This is most of what a user experiences.
2. **Cold redirect latency**: a brand-new profile's very first search which has to download the code and bang catalog.
3. **Bytes on the wire**: what is transfered to your browser (compressed)

Everything is timed address bar to redirect and stops at the request to the destination rather than its response since we are measuring the tool's overhead rather than how fast external sites are.

## How a sample is taken

Using Playwright with headless Chrome and a raw CDP session, we read
`Network.requestWillBeSent` wallTimes for two events:

- **t0**: the tool's own navigation-document request (pressing Enter).
- **t1**: the first request to the destination origin (e.g. `github.com`).

The sample is `t1 - t0`. The script measures **both states the same way**, so
they're directly comparable — the only difference is the browser context:

- **Cold**: a brand-new context per sample: no HTTP cache, no Service Worker, no IndexedDB.
- **Warm**: a context whose Service Worker is already installed and controlling,reused across samples. The script primes it first (visit the origin root, then waiting until `navigator.serviceWorker.controller` is set) and double checks the service worker took control.

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
```

Edit the `TOOLS` map and `DEST_HOST` at the top of the script to compare other tools or another builtin bang. It runs the warm phase then the cold phase, each printing per-tool medians + CIs, the paired difference with its CI, the win rate, and the permutation p-value.

## Measuring bytes on the wire

Latency needs a browser however payload doesn't! Wire size is measured with `curl` reporting the exact size.

```bash
# compressed transfer size
curl -s -H 'Accept-Encoding: br, gzip' -o /dev/null -w '%{size_download}\n' \
  https://s.dunkirk.sh/bangs.bin

# decoded size + the encoding type
curl -s --compressed -o /tmp/x -w 'decoded=%{size_download} type=%{content_type}\n' \
  https://s.dunkirk.sh/bangs.bin
```
