import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	build: {
		target: "esnext",
		sourcemap: false,
	},
	plugins: [
		VitePWA({
			registerType: "autoUpdate",
			workbox: {
				globPatterns: ["**/*.{js,css,html,svg}"],
				maximumFileSizeToCacheInBytes: 3 * 1048576,
				// The host 308-redirects /index.html to /. A redirected response
				// cannot be handed back to a navigation request, so precache and
				// fall back to "/" directly instead.
				manifestTransforms: [
					(entries) => ({
						manifest: entries.map((entry) =>
							entry.url === "index.html" ? { ...entry, url: "/" } : entry,
						),
						warnings: [],
					}),
				],
				navigateFallback: "/",
			},
		}),
	],
});
