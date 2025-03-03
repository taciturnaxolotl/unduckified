import { bangs } from "./hashbang.ts";
import {
	addToSearchHistory,
	clearSearchHistory,
	createAudio,
	getSearchHistory,
	storage,
} from "./libs.ts";

import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "./global.css";
import notFoundPageRender from "./404.ts";

export const CONSTANTS = {
	MAX_HISTORY: 500,
	ANIMATION_DURATION: 375,
	LOCAL_STORAGE_KEYS: {
		SEARCH_HISTORY: "search-history",
		SEARCH_COUNT: "search-count",
		HISTORY_ENABLED: "history-enabled",
		DEFAULT_BANG: "default-bang",
	},
	CUTIES: {
		NOTFOUND: [
			"(╯︵╰,)",
			"(｡•́︿•̀｡)",
			"(⊙_☉)",
			"(╯°□°）╯︵ ┻━┻",
			"(ಥ﹏ಥ)",
			"(✿◕‿◕✿)",
			"(╥﹏╥)",
			"(｡•́︿•̀｡)",
			"(✧ω✧)",
			"(•́_•̀)",
			"(╯°□°）╯︵ ┻━┻",
		],
		LEFT: ["╰（°□°╰）", "(◕‿◕´)", "(・ω・´)"],
		RIGHT: ["(╯°□°）╯", "(｀◕‿◕)", "(｀・ω・)"],
		UP: ["(↑°□°)↑", "(´◕‿◕)↑", "↑(´・ω・)↑"],
		DOWN: ["(↓°□°)↓", "(´◕‿◕)↓", "↓(´・ω・)↓"],
	},
};

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
							<label for="default-bang" id="bang-description">${bangs[data.LS_DEFAULT_BANG].s || "Unknown bang"}</label>
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

			if (
				Math.abs(differenceX) > Math.abs(differenceY) &&
				Math.abs(differenceX) > 100
			) {
				validatedElements.cutie.textContent =
					differenceX < 0
						? CONSTANTS.CUTIES.LEFT[
								Math.floor(Math.random() * CONSTANTS.CUTIES.LEFT.length)
							]
						: CONSTANTS.CUTIES.RIGHT[
								Math.floor(Math.random() * CONSTANTS.CUTIES.RIGHT.length)
							];
			} else if (Math.abs(differenceY) > 100) {
				validatedElements.cutie.textContent =
					differenceY < 0
						? CONSTANTS.CUTIES.UP[
								Math.floor(Math.random() * CONSTANTS.CUTIES.UP.length)
							]
						: CONSTANTS.CUTIES.DOWN[
								Math.floor(Math.random() * CONSTANTS.CUTIES.DOWN.length)
							];
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
		const bang = bangs[newDefaultBang];

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
const defaultBang = bangs[LS_DEFAULT_BANG];

function ensureProtocol(url: string, defaultProtocol = "https://") {
	try {
		const parsedUrl = new URL(url);
		return parsedUrl.href; // If valid, return as is
	} catch (e) {
		return `${defaultProtocol}${url}`;
	}
}

function getBangredirectUrl() {
	const url = new URL(window.location.href);
	const query = url.searchParams.get("q")?.trim() ?? "";

	switch (url.pathname.replace(/\/$/, "")) {
		case "": {
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

			const match = query.toLowerCase().match(/^!(\S+)|!(\S+)$/i);
			const selectedBang = match ? bangs[match[1] || match[2]] : defaultBang;
			const cleanQuery = match
				? query.replace(/!\S+\s*|^(\S+!|!\S+)$/i, "").trim()
				: query;

			// Redirect to base domain if cleanQuery is empty
			if (!cleanQuery && selectedBang?.d) {
				return ensureProtocol(selectedBang.d);
			}

			if (
				storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.HISTORY_ENABLED) === "true"
			) {
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
		default:
			notFoundPageRender();
			return null;
	}
}

function doRedirect() {
	const searchUrl = getBangredirectUrl();
	if (!searchUrl) return;
	window.location.replace(searchUrl);
}

doRedirect();
