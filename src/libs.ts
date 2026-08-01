const createAudio = (src: string) => {
	const audio = new Audio();
	audio.src = src;
	return audio;
};

const storage = {
	get: (key: string) => localStorage.getItem(key),
	set: (key: string, value: string) => localStorage.setItem(key, value),
	remove: (key: string) => localStorage.removeItem(key),
};

export { createAudio, storage };
