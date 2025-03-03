import { bangs } from "./bang";
import "./global.css";

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
	const app = document.querySelector<HTMLDivElement>("#app");
	if (!app) throw new Error("App element not found");
	app.innerHTML = `
		<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
				<header style="position: absolute; top: 1rem; right: 1rem;">
						<button class="settings-button">
								<img src="/gear.svg" alt="Settings" class="settings" />
						</button>
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
				</div>
				<footer class="footer">
						made with ♥ by <a href="https://github.com/taciturnaxolotl" target="_blank">Kieran Klukas</a> as <a href="https://github.com/taciturnaxolotl/unduck" target="_blank">open source</a> software
				</footer>
				<div class="modal" id="settings-modal">
          <div class="modal-content">
            <button class="close-modal">&times;</button>
            <h2>Settings</h2>
            <div>
              <label for="default-bang" id="bang-description">${bangs.find((b) => b.t === LS_DEFAULT_BANG)?.s || "Unknown bang"}</label>
              <div class="bang-select-container">
                <input type="text" id="default-bang" class="bang-select" value="${LS_DEFAULT_BANG}">
              </div>
            </div>
          </div>
        </div>
      </div>
		</div>
	`;

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

	urlInput.value = `${window.location.protocol}//${window.location.host}?q=%s`;

	copyButton.addEventListener("click", async () => {
		await navigator.clipboard.writeText(urlInput.value);
		copyIcon.src = "/clipboard-check.svg";

		setTimeout(() => {
			copyIcon.src = "/clipboard.svg";
		}, 2000);
	});

	const prefersReducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;
	if (!prefersReducedMotion) {
		const audio = new Audio("/heavier-tick-sprite.mp3");

		settingsButton.addEventListener("mouseenter", () => {
			audio.play();
		});

		settingsButton.addEventListener("mouseleave", () => {
			audio.pause();
			audio.currentTime = 0;
		});
	}

	settingsButton.addEventListener("click", () => {
		modal.style.display = "block";
		setOutsideElementsTabindex(modal, -1);
	});

	closeModal.addEventListener("click", () => {
		modal.style.display = "none";
		setOutsideElementsTabindex(modal, 0);
	});

	window.addEventListener("click", (event) => {
		if (event.target === modal) {
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

			// Remove animation classes after animation completes
			setTimeout(() => {
				defaultBangSelect.classList.remove("shake", "flash-red");
			}, 300);

			return;
		}

		localStorage.setItem("default-bang", newDefaultBang);
		description.innerText = bang.s;
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

	const match = query.match(/!(\S+)/i);
	const selectedBang = match
		? bangs.find((b) => b.t === match[1].toLowerCase())
		: defaultBang;
	const cleanQuery = match ? query.replace(/!\S+\s*/i, "").trim() : query;

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
