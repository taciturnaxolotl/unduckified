import { bangs } from "./hashbang";
import { writeFileSync } from "fs";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { cpus } from "os";
import dns from "dns";
import util from "util";

const TEST_QUERY = "test query";
const TIMEOUT = 5000;
const BATCH_SIZE = 10;

const dnsCache = new Map();
const lookup = util.promisify(dns.lookup);
const urlCache = new Map<string, boolean>();

const resolveHost = async (hostname: string) => {
	if (dnsCache.has(hostname)) {
		return dnsCache.get(hostname);
	}
	const address = await lookup(hostname);
	dnsCache.set(hostname, address);
	return address;
};

const testUrl = async (url: string, retries = 3): Promise<boolean> => {
	if (urlCache.has(url)) {
		return urlCache.get(url)!;
	}

	for (let i = 0; i < retries; i++) {
		try {
			const hostname = new URL(url).hostname;
			await resolveHost(hostname);

			const res = await fetch(url, {
				signal: AbortSignal.timeout(TIMEOUT),
				headers: { "User-Agent": "Mozilla/5.0" },
			});
			const result = res.status === 200;
			urlCache.set(url, result);
			return result;
		} catch (err) {
			if (i === retries - 1) {
				urlCache.set(url, false);
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000 * i));
		}
	}
	return false;
};

if (isMainThread) {
	const brokenBangs: { bang: string; url: string }[] = [];
	const bangEntries = Object.entries(bangs).slice(0, 500);
	const numThreads = cpus().length;
	const chunkSize = Math.ceil(bangEntries.length / numThreads);
	const chunks = Array.from({ length: numThreads }, (_, i) =>
		bangEntries.slice(i * chunkSize, (i + 1) * chunkSize),
	);

	let completedBangs = 0;
	const startTime = Date.now();
	const spinChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let spinIdx = 0;

	const updateProgress = setInterval(() => {
		const elapsedSeconds = (Date.now() - startTime) / 1000;
		const bangsPerSecond = (completedBangs / elapsedSeconds).toFixed(2);
		try {
			process.stdout.clearLine(0);
			process.stdout.cursorTo(0);
		} catch (err) {
			process.stdout.write("\r");
		}
		process.stdout.write(
			`${spinChars[spinIdx]} Completed ${completedBangs}/${bangEntries.length} bangs (${bangsPerSecond}/s)`,
		);
		spinIdx = (spinIdx + 1) % spinChars.length;
	}, 500);

	const workers = chunks.map((chunk) => {
		return new Promise((resolve) => {
			const worker = new Worker(__filename, {
				workerData: chunk,
			});

			worker.on("message", (msg) => {
				if (msg.type === "progress") {
					completedBangs++;
				} else {
					brokenBangs.push(...msg);
				}
			});

			worker.on("exit", resolve);
		});
	});

	Promise.all(workers).then(() => {
		clearInterval(updateProgress);
		process.stdout.write("\n");
		const brokenOutput = JSON.stringify(brokenBangs, null, 2);
		writeFileSync("src/bangs/broken-bangs.json", brokenOutput);
		console.log("Broken bangs written to broken-bangs.json");
	});
} else {
	const brokenBangsChunk: { bang: string; url: string }[] = [];
	const chunk = workerData as [string, { u: string }][];

	(async () => {
		for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
			const batch = chunk.slice(i, i + BATCH_SIZE);
			const results = await Promise.all(
				batch.map(async ([key, bang]) => {
					const url = bang.u.replace("{{{s}}}", encodeURIComponent(TEST_QUERY));
					const isWorking = await testUrl(url);
					return { key, url, isWorking };
				}),
			);

			for (const { key, url, isWorking } of results) {
				if (!isWorking) {
					brokenBangsChunk.push({ bang: key, url });
					try {
						process.stdout.clearLine(0);
						process.stdout.cursorTo(0);
					} catch (err) {
						process.stdout.write("\r");
					}
					console.log(`Bang ${key} is broken (${url})`);
				}
				parentPort?.postMessage({ type: "progress" });
			}

			if (brokenBangsChunk.length > 1000) {
				parentPort?.postMessage(brokenBangsChunk);
				brokenBangsChunk.length = 0;
			}
		}

		if (brokenBangsChunk.length > 0) {
			parentPort?.postMessage(brokenBangsChunk);
		}
	})();
}
