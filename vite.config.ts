import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { buildWorker } from "./src/build-workers.ts";

// The service worker and fallback script are compiled by a separate step into
// dist/, so the Vite dev server has nothing to serve for them and falls back to
// index.html (a text/html service worker, which the browser rejects). In dev we
// compile them on demand through the same builder the production build uses, so
// the two cannot drift apart.
function serveWorkerScript(virtualPath: string, entry: string): Plugin {
	return {
		name: `serve-${virtualPath.replace(/\W/g, "-")}`,
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url?.split("?")[0] !== virtualPath) return next();
				buildWorker(entry)
					.then((code) => {
						res.setHeader("Content-Type", "text/javascript");
						res.setHeader("Cache-Control", "no-store");
						res.end(code);
					})
					.catch((err: unknown) => {
						res.statusCode = 500;
						res.end(`// failed to build ${entry}\n${String(err)}`);
					});
			});
		},
	};
}

export default defineConfig({
	plugins: [
		serveWorkerScript("/sw.js", "src/sw/sw.ts"),
		serveWorkerScript("/fallback.js", "src/fallback.ts"),
	],
	build: {
		target: "esnext",
		sourcemap: false,
		rollupOptions: {
			input: {
				main: resolve(__dirname, "index.html"),
			},
		},
	},
});
