// Compiles the service worker and fallback module.
//
// Both are separate from the Vite bundle: they are loaded by URL rather than
// imported, so they need their own entry points.
//
// `bun build` has no --define on the command line, so this goes through the
// programmatic API. Both the production build and the dev server use it, which
// keeps the two from drifting apart.

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

if (import.meta.main) {
	for (const [name, entry] of Object.entries(ENTRIES)) {
		await Bun.write(`dist/${name}`, await buildWorker(entry));
	}
	console.log("built workers");
}
