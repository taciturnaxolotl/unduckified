// `preload = "none"` keeps setting `src` from kicking off a download on the
// critical path. The element is still fully usable — the first play() (or an
// explicit warmAudio() batch) fetches it then. See warmAudio in main.ts.
const createAudio = (src: string) => {
	const audio = new Audio();
	audio.preload = "none";
	audio.src = src;
	return audio;
};

const storage = {
	get: (key: string) => localStorage.getItem(key),
	set: (key: string, value: string) => localStorage.setItem(key, value),
	remove: (key: string) => localStorage.removeItem(key),
};

export { createAudio, storage };
