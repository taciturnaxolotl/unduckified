import { bangs } from "./bang.ts";

/* Developer script that converts ./bang.ts' array to hashmap.
 *   In your terminal of choice enter: cd src && bun .\hashbanggen.ts && cd ../
 *   If you should happen to enjoy PowerShell: cd src; bun .\hashbanggen.ts; cd ../
 * */

const hashbang: {
	[key: string]: {
		c?: string;
		d: string;
		r: number;
		s: string;
		sc?: string;
		t: string;
		u: string;
	};
} = {};
for (const bang of bangs) {
	hashbang[bang.t] = bang;
}

Bun.write(
	"./src/hashbang.ts",
	`export const bangs: {[key: string]: ({c?:string, d: string, r: number, s:string, sc?: string, t: string, u: string })} = ${JSON.stringify(hashbang)};`,
);
