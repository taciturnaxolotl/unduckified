import rawBangs from "./bangs.json" with { type: "json" };

// Developer script that converts ./bang.ts' array to hashmap.

const hashbang: {
  [key: string]: {
    c?: string; // Category
    sc?: string; // Subcategory
    d: string; // Domain
    ad?: string; // Alternate Domain
    r: number; // Rank (default to 0)
    s: string; // Website Name
    t: string; // Trigger
    ts?: string[]; // Additional Triggers
    u: string; // Template URL
    x?: string; // Regex pattern
    fmt?: string[]; // Format flags
    skip_tests?: boolean; // Skip tests flag
  };
}  = {
	t3: {
		c: "AI",
		d: "www.t3.chat",
		r: 0,
		s: "T3 Chat",
		sc: "AI",
		t: "t3",
		u: "https://www.t3.chat/new?q={{{s}}}",
	},
	m2: {
		c: "Online Services",
		d: "meta.dunkirk.sh",
		r: 0,
		s: "metasearch2",
		sc: "Search",
		t: "m2",
		u: "https://meta.dunkirk.sh/search?q={{{s}}}",
	},
	tiktok: {
		c: "Multimedia",
		sc: "Video",
		d: "www.tiktok.com",
		r: 0,
		s: "TikTok",
		t: "tiktok",
		u: "https://www.tiktok.com/search?q={{{s}}}",
	},
};

// Convert rawBangs array to hashbang object
rawBangs.forEach((bang: any) => {
  if (!bang.t || !bang.u || !bang.s || !bang.d) {
    console.warn(`Skipping invalid bang: ${JSON.stringify(bang)}`);
    return;
  }

  hashbang[bang.t] = {
    c: bang.c,
    sc: bang.sc,
    d: bang.d,
    ad: bang.ad,
    r: 0, // Default rank
    s: bang.s,
    t: bang.t,
    ts: bang.ts,
    u: bang.u,
    x: bang.x,
    fmt: bang.fmt,
    skip_tests: bang.skip_tests,
  };

  // Add additional triggers (if any) to the hashbang
  if (bang.ts) {
    bang.ts.forEach((trigger: string) => {
      hashbang[trigger] = { ...hashbang[bang.t], t: trigger };
    });
  }
});

Bun.write(
	"./src/bangs/hashbang.ts",
	`export const bangs: {[key: string]: ({c?:string, d: string, r: number, s:string, sc?: string, t: string, u: string })} = ${JSON.stringify(hashbang)};`,
);
