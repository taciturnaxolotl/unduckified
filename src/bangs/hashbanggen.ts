import rawBangs from "./bangs.json" with { type: "json" };

// Developer script that converts ./bangs.json array to hashmap.
// Only keeps fields needed at runtime: d (domain), ad (alt domain), s (name), u (url)

type RuntimeBang = {
	d: string;
	ad?: string;
	s: string;
	u: string;
};

const hashbang: Record<string, RuntimeBang> = {
	t3: {
		d: "www.t3.chat",
		s: "T3 Chat",
		u: "https://www.t3.chat/new?q={{{s}}}",
	},
	m2: {
		d: "meta.dunkirk.sh",
		s: "metasearch2",
		u: "https://meta.dunkirk.sh/search?q={{{s}}}",
	},
	tiktok: {
		d: "www.tiktok.com",
		s: "TikTok",
		u: "https://www.tiktok.com/search?q={{{s}}}",
	},
	image: {
		d: "duckduckgo.com",
		s: "Duckduckgo images",
		u: "https://duckduckgo.com/?q={{{s}}}&ia=images&iax=images&atb=v375-1",
	},
};

rawBangs.forEach((bang: any) => {
	if (!bang.t || !bang.u || !bang.s || !bang.d) {
		console.warn(`Skipping invalid bang: ${JSON.stringify(bang)}`);
		return;
	}

	const entry: RuntimeBang = {
		d: bang.d,
		s: bang.s,
		u: bang.u,
	};
	if (bang.ad) entry.ad = bang.ad;

	hashbang[bang.t] = entry;

	if (bang.ts) {
		bang.ts.forEach((trigger: string) => {
			hashbang[trigger] = entry;
		});
	}
});

Bun.write(
	"./src/bangs/hashbang.ts",
	`export const bangs: Record<string, { d: string; ad?: string; s: string; u: string }> = ${JSON.stringify(hashbang)};`,
);
