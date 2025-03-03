import { bangs } from "./bang";
import "./global.css";

function addToSearchHistory(
	query: string,
	bang: { bang: string; name: string; url: string },
) {
	const history = getSearchHistory();
	history.unshift({
		query,
		bang: bang.bang,
		name: bang.name,
		timestamp: Date.now(),
	});
	// Keep only last 500 searches
	history.splice(500);
	localStorage.setItem("search-history", JSON.stringify(history));
}

function getSearchHistory(): Array<{
	query: string;
	bang: string;
	name: string;
	timestamp: number;
}> {
	try {
		return JSON.parse(localStorage.getItem("search-history") || "[]");
	} catch {
		return [];
	}
}

function clearSearchHistory() {
	localStorage.setItem("search-history", "[]");
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

function noSearchDefaultPageRender() {
	const searchCount = localStorage.getItem("search-count") || "0";
	const historyEnabled = localStorage.getItem("history-enabled") === "true";
	const searchHistory = getSearchHistory();
	const app = document.querySelector<HTMLDivElement>("#app");
	if (!app) throw new Error("App element not found");
	app.innerHTML = `
		<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
    		<header style="position: absolute; top: 1rem; width: 100%;">
   			<div style="display: flex; justify-content: space-between; padding: 0 1rem;">
            <span>${searchCount} ${searchCount === "1" ? "search" : "searches"}</span>
    				<button class="settings-button">
    						<img src="/gear.svg" alt="Settings" class="settings" />
    				</button>
   			</div>
    		</header>
				<div class="content-container">
						<h1>┐( ˘_˘ )┌</h1>
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
							historyEnabled
								? `
									<h2 style="margin-top: 24px;">Recent Searches</h2>
									<div style="max-height: 200px; overflow-y: auto; text-align: left;">
									${
										searchHistory.length === 0
											? `<div style="padding: 8px; text-align: center;">No search history</div>`
											: searchHistory
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
              <label for="default-bang" id="bang-description">${bangs.find((b) => b.t === LS_DEFAULT_BANG)?.s || "Unknown bang"}</label>
              <div class="bang-select-container">
                <input type="text" id="default-bang" class="bang-select" value="${LS_DEFAULT_BANG}">
              </div>
            </div>
            <div class="settings-section">
              <h3>Search History (${searchHistory.length}/500)</h3>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <label class="switch">
                  <label for="history-toggle">Enable Search History</label>
                  <input type="checkbox" id="history-toggle" ${historyEnabled ? "checked" : ""}>
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

	const copyInput = app.querySelector<HTMLInputElement>(".url-input");
	if (!copyInput) throw new Error("Copy input not found");
	const copyButton = app.querySelector<HTMLButtonElement>(".copy-button");
	if (!copyButton) throw new Error("Copy button not found");
	const copyIcon = copyButton.querySelector("img");
	if (!copyIcon) throw new Error("Copy icon not found");
	const urlInput = app.querySelector<HTMLInputElement>(".url-input");
	if (!urlInput) throw new Error("URL input not found");
	const settingsButton =
		app.querySelector<HTMLButtonElement>(".settings-button");
	if (!settingsButton) throw new Error("Settings button not found");
	const modal = app.querySelector<HTMLDivElement>("#settings-modal");
	if (!modal) throw new Error("Modal not found");
	const closeModal = app.querySelector<HTMLSpanElement>(".close-modal");
	if (!closeModal) throw new Error("Close modal not found");
	const defaultBangSelect =
		app.querySelector<HTMLSelectElement>("#default-bang");
	if (!defaultBangSelect) throw new Error("Default bang select not found");
	const description =
		app.querySelector<HTMLParagraphElement>("#bang-description");
	if (!description) throw new Error("Bang description not found");
	const historyToggle = app.querySelector<HTMLInputElement>("#history-toggle");
	if (!historyToggle) throw new Error("History toggle not found");
	const clearHistory = app.querySelector<HTMLButtonElement>(".clear-history");
	if (!clearHistory) throw new Error("Clear history button not found");

	urlInput.value = `${window.location.protocol}//${window.location.host}?q=%s`;

	const prefersReducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;
	if (!prefersReducedMotion) {
		const spinAudio = new Audio("/heavier-tick-sprite.mp3");
		const toggleOffAudio = new Audio("/toggle-button-off.mp3");
		const toggleOnAudio = new Audio("/toggle-button-on.mp3");
		const clickAudio = new Audio("/click-button.mp3");
		const warningAudio = new Audio("/double-button.mp3");
		const copyAudio = new Audio("/foot-switch.mp3");

		copyButton.addEventListener("click", () => {
			copyAudio.currentTime = 0;
			copyAudio.play();
		});

		settingsButton.addEventListener("mouseenter", () => {
			spinAudio.play();
		});

		settingsButton.addEventListener("mouseleave", () => {
			spinAudio.pause();
			spinAudio.currentTime = 0;
		});

		historyToggle.addEventListener("change", () => {
			if (historyToggle.checked) {
				toggleOffAudio.pause();
				toggleOffAudio.currentTime = 0;
				toggleOnAudio.currentTime = 0;
				toggleOnAudio.play();
			} else {
				toggleOnAudio.pause();
				toggleOnAudio.currentTime = 0;
				toggleOffAudio.currentTime = 0;
				toggleOffAudio.play();
			}
		});

		clearHistory.addEventListener("click", () => {
			warningAudio.play();
		});

		defaultBangSelect.addEventListener("bangError", () => {
			warningAudio.currentTime = 0;
			warningAudio.play();
		});

		defaultBangSelect.addEventListener("bangSuccess", () => {
			clickAudio.currentTime = 0;
			clickAudio.play();
		});

		closeModal.addEventListener("closed", () => {
			settingsButton.classList.remove("rotate");
			spinAudio.playbackRate = 0.7;
			spinAudio.currentTime = 0;
			spinAudio.play();
			spinAudio.onended = () => {
				spinAudio.playbackRate = 1;
			};
		});
	}

	copyButton.addEventListener("click", async () => {
		await navigator.clipboard.writeText(urlInput.value);
		copyIcon.src = "/clipboard-check.svg";

		if (!prefersReducedMotion) copyInput.classList.add("flash-white");

		setTimeout(() => {
			copyInput.classList.remove("flash-white");
			copyIcon.src = "/clipboard.svg";
		}, 375);
	});

	settingsButton.addEventListener("click", () => {
		settingsButton.classList.add("rotate");
		modal.style.display = "block";
		setOutsideElementsTabindex(modal, -1);
	});

	closeModal.addEventListener("click", () => {
		closeModal.dispatchEvent(new Event("closed"));
		modal.style.display = "none";
		setOutsideElementsTabindex(modal, 0);
	});

	window.addEventListener("click", (event) => {
		if (event.target === modal) {
			closeModal.dispatchEvent(new Event("closed"));
			modal.style.display = "none";
			setOutsideElementsTabindex(modal, 0);
		}
	});

	// Save default bang
	defaultBangSelect.addEventListener("change", (event) => {
		const newDefaultBang = (event.target as HTMLSelectElement).value;
		const bang = bangs.find((b) => b.t === newDefaultBang);

		if (!bang) {
			// Invalid bang entered
			defaultBangSelect.value = LS_DEFAULT_BANG; // Reset to previous value
			defaultBangSelect.classList.add("shake", "flash-red");

			// Dispatch error event
			defaultBangSelect.dispatchEvent(new CustomEvent("bangError"));

			// Remove animation classes after animation completes
			setTimeout(() => {
				defaultBangSelect.classList.remove("shake", "flash-red");
			}, 300);

			return;
		}

		defaultBangSelect.dispatchEvent(new CustomEvent("bangSuccess"));

		localStorage.setItem("default-bang", newDefaultBang);
		description.innerText = bang.s;
	});

	// Enable/disable search history
	historyToggle.addEventListener("change", (event) => {
		localStorage.setItem(
			"history-enabled",
			(event.target as HTMLInputElement).checked.toString(),
		);
	});
	clearHistory.addEventListener("click", () => {
		clearSearchHistory();
		if (!prefersReducedMotion)
			setTimeout(() => {
				window.location.reload();
			}, 375);
		else window.location.reload();
	});
}

const LS_DEFAULT_BANG = localStorage.getItem("default-bang") ?? "ddg";
const defaultBang = bangs.find((b) => b.t === LS_DEFAULT_BANG);

function getBangredirectUrl() {
	const url = new URL(window.location.href);
	const query = url.searchParams.get("q")?.trim() ?? "";
	if (!query) {
		noSearchDefaultPageRender();
		return null;
	}

	// increment search count
	const count = (
		Number.parseInt(localStorage.getItem("search-count") || "0") + 1
	).toString();
	localStorage.setItem("search-count", count);

	const match = query.match(/!(\S+)/i);
	const selectedBang = match
		? bangs.find((b) => b.t === match[1].toLowerCase())
		: defaultBang;
	const cleanQuery = match ? query.replace(/!\S+\s*/i, "").trim() : query;

	// Add search to history
	if (localStorage.getItem("history-enabled") === "true") {
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
