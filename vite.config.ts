import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { buildWorker } from "./src/build-workers.ts";

// Keep the landing bundle off the cold redirect path. Vite injects the hashed
// entry module (and the modulepreload polyfill) into index.html; left as static
// tags the browser downloads them on every visit, including a `?q=!bang`
// redirect that immediately navigates away — starving the one fetch that
// matters (bangs.bin) and pulling the sound files with it. This strips those
// module <script> tags at build time and hands their URLs to the inline loader
// in index.html via window.__APP__, which injects them only when the page is
// NOT redirecting. The stylesheet is left in place (tiny, and keeping it static
// avoids a flash of unstyled content on the landing page). Build-only: in dev
// the original /src/main.ts tag loads normally.
function deferAppBundle(): Plugin {
	return {
		name: "defer-app-bundle",
		apply: "build",
		enforce: "post",
		transformIndexHtml(html, ctx) {
			if (!ctx.filename.endsWith("index.html")) return html;
			const js: string[] = [];
			let out = html.replace(
				/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g,
				(_m, src) => { js.push(src); return ""; },
			);
			// Drop modulepreload hints too — they'd prefetch chunks on the redirect
			// path; loadApp() pulls what it needs when it injects the entry.
			out = out.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, "");
			out = out.replace(
				"</head>",
				`<script>window.__APP__=${JSON.stringify({ js })}</script></head>`,
			);
			return out;
		},
	};
}

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
		deferAppBundle(),
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
