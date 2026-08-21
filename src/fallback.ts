// Fallback module: runs in main thread when SW isn't active yet.
// The lookup and the query grammar are shared with the service worker
// (src/bangs/catalog.ts); what lives here is where this context keeps its
// settings, which is localStorage.

import { type Catalog, openCatalog, resolveQuery } from "./bangs/catalog.ts";

let catalog: Catalog | null = null;

export async function initializeBangData(buffer: ArrayBuffer): Promise<void> {
	if (catalog) return;
	catalog = openCatalog(buffer);
}

// Custom bangs are stored as raw URL templates with a {{{s}}} placeholder,
// unlike the worker's pre-split prefix/suffix pairs.
function resolveCustom(trigger: string, query: string): string | null {
	let bangs: Record<string, { u: string }>;
	try {
		bangs = JSON.parse(localStorage.getItem("custom-bangs") || "{}");
	} catch {
		return null;
	}
	const url = bangs[trigger]?.u;
	if (!url) return null;

	const idx = url.indexOf("{{{s}}}");
	if (idx === -1) return url;
	if (!query) {
		try { return new URL(url.substring(0, idx)).origin; } catch {}
	}
	return url.substring(0, idx) + encodeURIComponent(query) + url.substring(idx + 7);
}

export async function resolveFallback(query: string, buffer?: ArrayBuffer): Promise<string | null> {
	// Fetch bangs.bin if not already loaded
	if (!catalog) {
		if (!buffer) {
			const resp = await fetch("/bangs.bin");
			buffer = await resp.arrayBuffer();
		}
		await initializeBangData(buffer);
	}

	return resolveQuery(catalog, query, {
		defaultTrigger: (localStorage.getItem("default-bang") || "ddg").toLowerCase(),
		custom: resolveCustom,
	});
}

// Expose globally for inline script
declare global {
	interface Window {
		resolveFallback: typeof resolveFallback;
	}
}
window.resolveFallback = resolveFallback;

// Signal that the fallback module is ready
if (typeof window !== "undefined") {
	window.dispatchEvent(new Event("fallbackReady"));
}
