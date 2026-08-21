// `preload = "none"` keeps setting `src` from kicking off a download on the
// critical path. The element is still fully usable — the first play() (or an
// explicit warmAudio() batch) fetches it then. See warmAudio in main.ts.
const createAudio = (src: string) => {
	const audio = new Audio();
	audio.preload = "none";
	audio.src = src;
	return audio;
};

// Settings live in localStorage, which the edge redirect (functions/index.ts)
// cannot read. It answers the first search of a profile, before the worker
// exists, and would otherwise resolve a custom bang or a custom default the
// wrong way. So storing either one raises a cookie, which is the one thing the
// edge can see, and it stands aside while that cookie is set. Clearing them
// lowers it again.
const SETTINGS_KEYS = new Set(["default-bang", "custom-bangs"]);
const SETTINGS_COOKIE = "unduck-settings";

function syncSettingsCookie() {
	const customBangs = localStorage.getItem("custom-bangs");
	const configured =
		Boolean(localStorage.getItem("default-bang")) ||
		Boolean(customBangs && customBangs !== "{}");
	const secure = location.protocol === "https:" ? "; Secure" : "";
	document.cookie = configured
		? `${SETTINGS_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
		: `${SETTINGS_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

const storage = {
	get: (key: string) => localStorage.getItem(key),
	set: (key: string, value: string) => {
		localStorage.setItem(key, value);
		if (SETTINGS_KEYS.has(key)) syncSettingsCookie();
	},
	remove: (key: string) => {
		localStorage.removeItem(key);
		if (SETTINGS_KEYS.has(key)) syncSettingsCookie();
	},
};

export { createAudio, storage };
