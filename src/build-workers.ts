// Compiles the service worker and fallback module.
//
// Both are separate from the Vite bundle: they are loaded by URL rather than
// imported, so they need their own entry points.
//
// `bun build` has no --define on the command line, so this goes through the
// programmatic API. Both the production build and the dev server use it, which
// keeps the two from drifting apart.

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

interface WorkerBuildOptions {
	minify?: boolean;
}

const ENTRIES: Record<string, string> = {
	"sw.js": "src/sw/sw.ts",
	"fallback.js": "src/fallback.ts",
};

/** Build one worker entry and return the bundled source. */
export async function buildWorker(
	entry: string,
	{ minify = true }: WorkerBuildOptions = {},
): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		minify,
	});
	if (!result.success) {
		throw new Error(
			`Failed to build ${entry}\n${result.logs.map(String).join("\n")}`,
		);
	}
	return await result.outputs[0].text();
}

// Strip OS junk that macOS drops into public/ (.DS_Store, ._* AppleDouble
// files). Vite copies publicDir wholesale, so these ride into dist/ and — since
// deploys go straight from a local dist/ — onto the live site (a shipped
// .DS_Store also leaks the directory listing). .gitignore does not help: it
// keeps them out of git, not out of the copy.
function stripOsJunk(dir: string): void {
	const isJunk = (name: string) => name === ".DS_Store" || name.startsWith("._");
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) stripOsJunk(p);
		else if (isJunk(e.name)) rmSync(p);
	}
}

// Cloudflare compresses on the fly at only brotli quality ~4, leaving the
// catalog ~15% larger on the wire than it needs to be. CF passes a
// pre-compressed body through untouched when it carries Content-Encoding and
// `no-transform` (both set for /bangs.bin in public/_headers), so we ship
// dist/bangs.bin already brotli-compressed at maximum quality. The source in
// public/ stays raw, so the dev server and any non-CF fetch keep working; only
// the deployed artifact is compressed, and the browser's fetch() decodes it
// transparently — the service worker and page still see the original bytes.
function precompressCatalog(path: string): void {
	let raw: Buffer;
	try { raw = readFileSync(path); } catch { return; }
	// Only compress the raw catalog, identified by its little-endian magic
	// (0x554e4455); if a prior run already replaced it with a brotli body, leave
	// it alone.
	const isRaw = raw.length >= 4 && raw.readUInt32LE(0) === 0x554e4455;
	if (!isRaw) return;
	const br = brotliCompressSync(raw, {
		params: {
			[zlibConstants.BROTLI_PARAM_QUALITY]: 11,
			[zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
		},
	});
	writeFileSync(path, br);
	const pct = ((1 - br.length / raw.length) * 100).toFixed(1);
	console.log(`precompressed bangs.bin: ${raw.length} -> ${br.length} B (brotli -11, -${pct}%)`);
}

if (import.meta.main) {
	for (const [name, entry] of Object.entries(ENTRIES)) {
		await Bun.write(`dist/${name}`, await buildWorker(entry));
	}
	console.log("built workers");
	stripOsJunk("dist");
	precompressCatalog("dist/bangs.bin");
}
