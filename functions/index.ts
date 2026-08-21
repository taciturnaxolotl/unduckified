// The first search of a profile, answered at the edge.
//
// Every other search is resolved on the device: the service worker intercepts
// the navigation and never touches the network. But a browser that has no
// worker yet has to be sent the page first, and the page then has to download
// the whole catalog before it can work out where the user was going. That is
// two round trips to answer a question this request already contains, since
// the navigation arrives here as `/?q=!gh test`.
//
// So when we can answer it, we answer it. Anything we cannot answer falls
// through to the page, which resolves it exactly as it does today. The worker
// installs on that same first visit either way, so this runs once per profile
// and then never again.
//
// What we cannot answer is anything that depends on settings. Custom bangs and
// a custom default provider live in localStorage, which is invisible from here,
// so the client sets a cookie when it has either (see storage in src/libs.ts)
// and we stand aside for those requests rather than guess.

import { type Catalog, openCatalog, resolveQuery } from "../src/bangs/catalog.ts";
import { CATALOG_B64 } from "../src/bangs/catalog-embed.ts";

// Set by the client whenever a default bang or a custom bang is stored.
const SETTINGS_COOKIE = /(?:^|;\s*)unduck-settings=1(?:\s*;|$)/;
// Matches the client's fallback when nothing has been configured.
const DEFAULT_TRIGGER = "ddg";

// Decoding ~700 KiB costs a few milliseconds, so it happens once per isolate
// and only when a request actually needs a redirect. A landing-page visit
// returns before touching this.
let catalog: Catalog | null = null;
function getCatalog(): Catalog {
	if (!catalog) {
		const bytes = Uint8Array.from(atob(CATALOG_B64), (c) => c.charCodeAt(0));
		catalog = openCatalog(bytes.buffer);
	}
	return catalog;
}

export async function onRequestGet(context: {
	request: Request;
	next: () => Promise<Response>;
}): Promise<Response> {
	const url = new URL(context.request.url);
	const q = url.searchParams.get("q");
	if (q === null) return context.next();

	const trimmed = q.trim();
	// Leave the settings shortcut to the page, same as the worker does.
	if (trimmed === "" || trimmed === "!" || trimmed === "!settings") {
		return context.next();
	}

	// This user has settings we cannot see. Their client knows better.
	if (SETTINGS_COOKIE.test(context.request.headers.get("cookie") ?? "")) {
		return context.next();
	}

	let dest: string | null = null;
	try {
		dest = resolveQuery(getCatalog(), trimmed, { defaultTrigger: DEFAULT_TRIGGER });
		// A header holds bytes, and 61 bangs point at URLs with
		// non-ASCII in them ("…/index.php?title=Spécial:Recherche"). The client
		// hands those to location.replace(), which encodes them on the way out;
		// here they have to be encoded before they can be a Location at all.
		// Parsing also rejects anything malformed before we redirect to it.
		if (dest) dest = new URL(dest).toString();
	} catch {
		// A bad catalog or an unusable URL is not worth a dead tab: the page
		// can still resolve this the long way.
		return context.next();
	}
	if (!dest) return context.next();

	// A search is personal and the destination depends on a cookie, so this
	// response belongs to one request and no cache should ever repeat it.
	return new Response(null, {
		status: 302,
		headers: { Location: dest, "Cache-Control": "private, no-store" },
	});
}
