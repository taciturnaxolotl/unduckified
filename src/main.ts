import { bangs } from "./bang";
import "./global.css";

const CONSTANTS = {
	MAX_HISTORY: 500,
	ANIMATION_DURATION: 375,
	LOCAL_STORAGE_KEYS: {
		SEARCH_HISTORY: "search-history",
		SEARCH_COUNT: "search-count",
		HISTORY_ENABLED: "history-enabled",
		DEFAULT_BANG: "default-bang",
	},
};

const storage = {
	get: (key: string) => localStorage.getItem(key),
	set: (key: string, value: string) => localStorage.setItem(key, value),
	remove: (key: string) => localStorage.removeItem(key),
};

const memoizedGetSearchHistory = (() => {
	let cache: Array<{
		query: string;
		bang: string;
		name: string;
		timestamp: number;
	}> | null = null;
	return () => {
		if (!cache) {
			cache = JSON.parse(
				storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_HISTORY) || "[]",
			);
		}
		return cache;
	};
})();

function addToSearchHistory(
	query: string,
	bang: { bang: string; name: string; url: string },
) {
	const history = memoizedGetSearchHistory();
	if (!history) return;

	history.unshift({
		query,
		bang: bang.bang,
		name: bang.name,
		timestamp: Date.now(),
	});
	history.splice(CONSTANTS.MAX_HISTORY);
	storage.set(
		CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_HISTORY,
		JSON.stringify(history),
	);
}

function getSearchHistory(): Array<{
	query: string;
	bang: string;
	name: string;
	timestamp: number;
}> {
	try {
		return JSON.parse(
			storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_HISTORY) || "[]",
		);
	} catch {
		return [];
	}
}

function clearSearchHistory() {
	storage.set(CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_HISTORY, "[]");
}

function getFocusableElements(
	root: HTMLElement = document.body,
): HTMLElement[] {
	return Array.from(
		root.querySelectorAll<HTMLElement>(
			'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
		),
	);
}

function setOutsideElementsTabindex(modal: HTMLElement, tabindex: number) {
	const modalElements = getFocusableElements(modal);
	const allElements = getFocusableElements();

	for (const element of allElements) {
		if (!modalElements.includes(element)) {
			element.setAttribute("tabindex", tabindex.toString());
		}
	}
}

const createTemplate = (data: {
	searchCount: string;
	historyEnabled: boolean;
	searchHistory: Array<{
		bang: string;
		query: string;
		name: string;
		timestamp: number;
	}>;
	LS_DEFAULT_BANG: string;
}) => `
	<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
		<header style="position: absolute; top: 1rem; width: 100%;">
			<div style="display: flex; justify-content: space-between; padding: 0 1rem;">
				<span>${data.searchCount} ${data.searchCount === "1" ? "search" : "searches"}</span>
				<button class="settings-button">
					<img src="/gear.svg" alt="Settings" class="settings" />
				</button>
			</div>
		</header>
		<div class="content-container">
			<h1 id="cutie">┐( ˘_˘ )┌</h1>
			<p>DuckDuckGo's bang redirects are too slow. Add the following URL as a custom search engine to your browser. Enables <a href="https://duckduckgo.com/bang.html" target="_blank">all of DuckDuckGo's bangs.</a></p>
			<div class="url-container">
				<input
					type="text"
					class="url-input"
					value="https://unduck.link?q=%s"
					readonly
				/>
				<button class="copy-button">
					<img src="/clipboard.svg" alt="Copy" />
				</button>
			</div>
				${
					data.historyEnabled
						? `
							<h2 style="margin-top: 24px;">Recent Searches</h2>
							<div style="max-height: 200px; overflow-y: auto; text-align: left;">
							${
								data.searchHistory.length === 0
									? `<div style="padding: 8px; text-align: center;">No search history</div>`
									: data.searchHistory
											.map(
												(search) => `
													<div style="padding: 8px; border-bottom: 1px solid var(--border-color);">
														<a href="?q=!${search.bang} ${search.query}">${search.name}: ${search.query}</a>
														<span style="float: right; color: var(--text-color-secondary);">
															${new Date(search.timestamp).toLocaleString()}
														</span>
													</div>
											`,
											)
											.join("")
							}
							</div>
						`
						: ""
				}
		</div>
		<footer class="footer">
			made with ♥ by <a href="https://github.com/taciturnaxolotl" target="_blank">Kieran Klukas</a> as <a href="https://github.com/taciturnaxolotl/unduck" target="_blank">open source</a> software
		</footer>
		<div class="modal" id="settings-modal">
			<div class="modal-content">
					<button class="close-modal">&times;</button>
					<h2>Settings</h2>
					<div class="settings-section">
							<label for="default-bang" id="bang-description">${bangs.find((b) => b.t === data.LS_DEFAULT_BANG)?.s || "Unknown bang"}</label>
							<div class="bang-select-container">
									<input type="text" id="default-bang" class="bang-select" value="${data.LS_DEFAULT_BANG}">
							</div>
					</div>
					<div class="settings-section">
							<h3>Search History (${data.searchHistory.length}/500)</h3>
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<label class="switch">
										<label for="history-toggle">Enable Search History</label>
										<input type="checkbox" id="history-toggle" ${data.historyEnabled ? "checked" : ""}>
										<span class="slider round"></span>
									</label>
									<button class="clear-history">Clear History</button>
							</div>
					</div>
				</div>
			</div>
		</div>
	</div>
`;

const createAudio = (src: string) => {
	const audio = new Audio();
	audio.src = src;
	return audio;
};

function noSearchDefaultPageRender() {
	const searchCount =
		storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_COUNT) || "0";
	const historyEnabled =
		storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.HISTORY_ENABLED) === "true";
	const searchHistory = getSearchHistory();
	const app = document.querySelector<HTMLDivElement>("#app");
	if (!app) throw new Error("App element not found");

	app.innerHTML = createTemplate({
		searchCount,
		historyEnabled,
		searchHistory,
		LS_DEFAULT_BANG,
	});

	const elements = {
		app,
		cutie: app.querySelector<HTMLHeadingElement>("#cutie"),
		copyInput: app.querySelector<HTMLInputElement>(".url-input"),
		copyButton: app.querySelector<HTMLButtonElement>(".copy-button"),
		copyIcon: app.querySelector<HTMLImageElement>(".copy-button img"),
		urlInput: app.querySelector<HTMLInputElement>(".url-input"),
		settingsButton: app.querySelector<HTMLButtonElement>(".settings-button"),
		modal: app.querySelector<HTMLDivElement>("#settings-modal"),
		closeModal: app.querySelector<HTMLSpanElement>(".close-modal"),
		defaultBangSelect: app.querySelector<HTMLSelectElement>("#default-bang"),
		description: app.querySelector<HTMLParagraphElement>("#bang-description"),
		historyToggle: app.querySelector<HTMLInputElement>("#history-toggle"),
		clearHistory: app.querySelector<HTMLButtonElement>(".clear-history"),
	} as const;

	// Validate all elements exist
	for (const [key, element] of Object.entries(elements)) {
		if (!element) throw new Error(`${key} not found`);
	}

	// After validation, we can assert elements are non-null
	const validatedElements = elements as {
		[K in keyof typeof elements]: NonNullable<(typeof elements)[K]>;
	};

	validatedElements.urlInput.value = `${window.location.protocol}//${window.location.host}?q=%s`;

	const prefersReducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;

	if (!prefersReducedMotion) {
		// Add mouse tracking behavior
		document.addEventListener("click", (e) => {
			const x = e.clientX;
			const y = e.clientY;
			const centerX = window.innerWidth / 2;
			const centerY = window.innerHeight / 2;
			const differenceX = x - centerX;
			const differenceY = y - centerY;

			// Left-facing cuties
			const leftCuties = ["╰（°□°╰）", "(◕‿◕´)", "(・ω・´)"];

			// Right-facing cuties
			const rightCuties = ["(╯°□°）╯", "(｀◕‿◕)", "(｀・ω・)"];

			// Up-facing cuties
			const upCuties = ["(↑°□°)↑", "(´◕‿◕)↑", "↑(´・ω・)↑"];

			// Down-facing cuties
			const downCuties = ["(↓°□°)↓", "(´◕‿◕)↓", "↓(´・ω・)↓"];

			if (
				Math.abs(differenceX) > Math.abs(differenceY) &&
				Math.abs(differenceX) > 100
			) {
				validatedElements.cutie.textContent =
					differenceX < 0
						? leftCuties[Math.floor(Math.random() * leftCuties.length)]
						: rightCuties[Math.floor(Math.random() * rightCuties.length)];
			} else if (Math.abs(differenceY) > 100) {
				validatedElements.cutie.textContent =
					differenceY < 0
						? upCuties[Math.floor(Math.random() * upCuties.length)]
						: downCuties[Math.floor(Math.random() * downCuties.length)];
			}
		});

		const audio = {
			spin: createAudio("/heavier-tick-sprite.mp3"),
			toggleOff: createAudio("/toggle-button-off.mp3"),
			toggleOn: createAudio("/toggle-button-on.mp3"),
			click: createAudio("/click-button.mp3"),
			warning: createAudio("/double-button.mp3"),
			copy: createAudio("/foot-switch.mp3"),
		};

		validatedElements.copyButton.addEventListener("click", () => {
			audio.copy.currentTime = 0;
			audio.copy.play();
		});

		validatedElements.settingsButton.addEventListener("mouseenter", () => {
			audio.spin.play();
		});

		validatedElements.settingsButton.addEventListener("mouseleave", () => {
			audio.spin.pause();
			audio.spin.currentTime = 0;
		});

		validatedElements.historyToggle.addEventListener("change", () => {
			if (validatedElements.historyToggle.checked) {
				audio.toggleOff.pause();
				audio.toggleOff.currentTime = 0;
				audio.toggleOn.currentTime = 0;
				audio.toggleOn.play();
			} else {
				audio.toggleOn.pause();
				audio.toggleOn.currentTime = 0;
				audio.toggleOff.currentTime = 0;
				audio.toggleOff.play();
			}
		});

		validatedElements.clearHistory.addEventListener("click", () => {
			audio.warning.play();
		});

		validatedElements.defaultBangSelect.addEventListener("bangError", () => {
			audio.warning.currentTime = 0;
			audio.warning.play();
		});

		validatedElements.defaultBangSelect.addEventListener("bangSuccess", () => {
			audio.click.currentTime = 0;
			audio.click.play();
		});

		validatedElements.closeModal.addEventListener("closed", () => {
			validatedElements.settingsButton.classList.remove("rotate");
			audio.spin.playbackRate = 0.7;
			audio.spin.currentTime = 0;
			audio.spin.play();
			audio.spin.onended = () => {
				audio.spin.playbackRate = 1;
			};
		});
	}

	validatedElements.copyButton.addEventListener("click", async () => {
		await navigator.clipboard.writeText(validatedElements.urlInput.value);
		validatedElements.copyIcon.src = "/clipboard-check.svg";

		if (!prefersReducedMotion)
			validatedElements.copyInput.classList.add("flash-white");

		setTimeout(() => {
			validatedElements.copyInput.classList.remove("flash-white");
			validatedElements.copyIcon.src = "/clipboard.svg";
		}, 375);
	});

	validatedElements.settingsButton.addEventListener("click", () => {
		validatedElements.settingsButton.classList.add("rotate");
		validatedElements.modal.style.display = "block";
		setOutsideElementsTabindex(validatedElements.modal, -1);
	});

	validatedElements.closeModal.addEventListener("click", () => {
		validatedElements.closeModal.dispatchEvent(new Event("closed"));
	});

	window.addEventListener("click", (event) => {
		if (event.target === validatedElements.modal) {
			validatedElements.closeModal.dispatchEvent(new Event("closed"));
		}
	});

	validatedElements.closeModal.addEventListener("closed", () => {
		validatedElements.modal.style.display = "none";
		setOutsideElementsTabindex(validatedElements.modal, 0);

		if (validatedElements.historyToggle.checked !== historyEnabled)
			if (!prefersReducedMotion)
				setTimeout(() => {
					window.location.reload();
				}, 300);
			else window.location.reload();
	});

	validatedElements.defaultBangSelect.addEventListener("change", (event) => {
		const newDefaultBang = (event.target as HTMLSelectElement).value;
		const bang = bangs.find((b) => b.t === newDefaultBang);

		if (!bang) {
			validatedElements.defaultBangSelect.value = LS_DEFAULT_BANG;
			validatedElements.defaultBangSelect.classList.add("shake", "flash-red");
			validatedElements.defaultBangSelect.dispatchEvent(
				new CustomEvent("bangError"),
			);
			setTimeout(() => {
				validatedElements.defaultBangSelect.classList.remove(
					"shake",
					"flash-red",
				);
			}, 300);
			return;
		}

		validatedElements.defaultBangSelect.dispatchEvent(
			new CustomEvent("bangSuccess"),
		);
		storage.set(CONSTANTS.LOCAL_STORAGE_KEYS.DEFAULT_BANG, newDefaultBang);
		validatedElements.description.innerText = bang.s;
	});

	validatedElements.historyToggle.addEventListener("change", (event) => {
		storage.set(
			CONSTANTS.LOCAL_STORAGE_KEYS.HISTORY_ENABLED,
			(event.target as HTMLInputElement).checked.toString(),
		);
	});

	validatedElements.clearHistory.addEventListener("click", () => {
		clearSearchHistory();
		if (!prefersReducedMotion)
			setTimeout(() => {
				window.location.reload();
			}, 375);
		else window.location.reload();
	});
}

const LS_DEFAULT_BANG =
	storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.DEFAULT_BANG) ?? "ddg";
const defaultBang = bangs.find((b) => b.t === LS_DEFAULT_BANG);

function getBangredirectUrl() {
	const url = new URL(window.location.href);
	const query = url.searchParams.get("q")?.trim() ?? "";
	if (!query) {
		noSearchDefaultPageRender();
		return null;
	}

	const count = (
		Number.parseInt(
			storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_COUNT) || "0",
		) + 1
	).toString();
	storage.set(CONSTANTS.LOCAL_STORAGE_KEYS.SEARCH_COUNT, count);

	const match = query.match(/^!(\S+)|!(\S+)$/i);
	const selectedBang = match
		? bangs.find((b) => b.t === match[1].toLowerCase())
		: defaultBang;
	const cleanQuery = match
		? query.replace(/!\S+\s*|^(\S+!|!\S+)$/i, "").trim()
		: query;

	if (storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.HISTORY_ENABLED) === "true") {
		addToSearchHistory(cleanQuery, {
			bang: selectedBang?.t || "",
			name: selectedBang?.s || "",
			url: selectedBang?.u || "",
		});
	}

	return selectedBang?.u.replace(
		"{{{s}}}",
		encodeURIComponent(cleanQuery).replace(/%2F/g, "/"),
	);
}

function doRedirect() {
	const searchUrl = getBangredirectUrl();
	if (!searchUrl) return;
	window.location.replace(searchUrl);
}

doRedirect();
