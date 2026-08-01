import "./global.css";
import { createAudio, storage } from "./libs.ts";

import notFoundPageRender from "./404.ts";

// Register service worker (non-blocking). updateViaCache:"none" keeps the
// browser from serving a stale sw.js and pinning users to an old build.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker
		.register("/sw.js", { updateViaCache: "none" })
		.catch(() => {});
}

export const CONSTANTS = {
	ANIMATION_DURATION: 375,
	LOCAL_STORAGE_KEYS: {
		DEFAULT_BANG: "default-bang",
		CUSTOM_BANGS: "custom-bangs",
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

const customBangs: {
	[key: string]: {
		d: string;
		ad?: string;
		s: string;
		u: string;
	};
} = JSON.parse(localStorage.getItem("custom-bangs") || "{}");

// Sync custom bangs to service worker
function syncCustomBangsToSW() {
	if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
		navigator.serviceWorker.controller.postMessage({
			type: "UPDATE_CUSTOM_BANGS",
			bangs: customBangs,
		});
	}
}

// Get the active service worker, waiting for it to be ready if needed.
async function getReadySW(): Promise<ServiceWorker | null> {
	if (!("serviceWorker" in navigator)) return null;
	if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
	try {
		const reg = await Promise.race([
			navigator.serviceWorker.ready,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
		]);
		return reg?.active ?? null;
	} catch {
		return null;
	}
}

// Ask the service worker for the current search count
async function requestSearchCount(): Promise<number> {
	const sw = await getReadySW();
	if (!sw) return 0;
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (event) => {
			resolve(event.data?.count ?? 0);
		};
		sw.postMessage({ type: "GET_SEARCH_COUNT" }, [channel.port2]);
	});
}

// Ask the service worker whether a bang trigger exists (built-in or custom)
async function checkBangExists(trigger: string): Promise<boolean> {
	const sw = await getReadySW();
	if (!sw) return false;
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (event) => {
			resolve(Boolean(event.data?.exists));
		};
		sw.postMessage({ type: "CHECK_BANG_EXISTS", trigger }, [channel.port2]);
	});
}

let editingShortcut: string | null = null;

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

const createTemplate = (data: { LS_DEFAULT_BANG: string }) => `
	<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
		<header style="position: absolute; top: 1rem; width: 100%;">
			<div style="display: flex; justify-content: space-between; padding: 0 1rem;">
				<span id="search-count">…</span>
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
		</div>
		<footer class="footer">
			made with ♥ by <a href="https://github.com/taciturnaxolotl" target="_blank">Kieran Klukas</a> as <a href="https://github.com/taciturnaxolotl/unduck" target="_blank">open source</a> software
		</footer>
		<div class="modal" id="settings-modal">
			<div class="modal-content">
					<button class="close-modal">&times;</button>
					<h2>Settings</h2>
					<div class="settings-section">
					    <h3>Bangs</h3>
							<label for="default-bang" id="bang-description">Default Bang: !${data.LS_DEFAULT_BANG}</label>
							<div class="bang-select-container">
									<input type="text" id="default-bang" class="bang-select" value="${data.LS_DEFAULT_BANG}">
							</div>
							<p class="help-text">The best way to add new bangs is by submitting them on <a href="https://duckduckgo.com/newbang" target="_blank">DuckDuckGo</a> but you can also add them below</p>
							<div style="margin-top: 16px;">
								<h4>Add Custom Bang</h4>
								<div class="custom-bang-inputs">
									<input type="text" placeholder="Bang name" id="bang-name" class="bang-name">
									<input type="text" placeholder="Shortcut (e.g. !ddg)" id="bang-shortcut" class="bang-shortcut">
									<input type="text" placeholder="Search URL with {{{s}}}" id="bang-search-url" class="bang-search-url">
									<input type="text" placeholder="Base domain" id="bang-base-url" class="bang-base-url">
									<div style="text-align: right;">
										<button class="add-bang">Add Bang</button>
									</div>
								</div>
								${
									Object.keys(customBangs).length > 0
										? `
  								<h4>Your Custom Bangs</h4>
  								<div class="custom-bangs-list">
  								${Object.entries(customBangs)
										.map(
											([shortcut, bang]) => `
  									<div class="custom-bang-item">
   									<table class="custom-bang-info">
   											<tr>
  												<td class="custom-bang-name">${bang.s}</td>
  												<td class="custom-bang-shortcut"><code>!${shortcut}</code></td>
  												<td class="custom-bang-base">${bang.d}</td>
   											</tr>
   									</table>
  										<div class="custom-bang-url">${bang.u}</div>
  										<div class="custom-bang-actions">
  											<button class="edit-bang" data-shortcut="${shortcut}">Edit</button>
  											<button class="remove-bang" data-shortcut="${shortcut}">Remove</button>
  										</div>
  									</div>
  								`,
										)
										.join("")}
  								</div>
								`
										: ""
								}
							</div>
					</div>
					<div class="settings-section">
							<h3>Settings Import/Export</h3>
							<p class="help-text">Export your settings and custom bangs to a file, or import them from a previously saved file.</p>
							<div style="display: flex; gap: 8px; margin-top: 8px;">
								<button class="export-settings">Export Settings</button>
								<button class="import-settings">Import Settings</button>
								<input type="file" id="import-file" accept=".json" style="display: none;">
							</div>
					</div>
				</div>
			</div>
		</div>
	</div>
`;

function noSearchDefaultPageRender() {
	const app = document.querySelector<HTMLDivElement>("#app");
	if (!app) throw new Error("App element not found");

	app.innerHTML = createTemplate({ LS_DEFAULT_BANG });

	const elements = {
		app,
		cutie: app.querySelector<HTMLHeadingElement>("#cutie"),
		searchCount: app.querySelector<HTMLSpanElement>("#search-count"),
		copyInput: app.querySelector<HTMLInputElement>(".url-input"),
		copyButton: app.querySelector<HTMLButtonElement>(".copy-button"),
		copyIcon: app.querySelector<HTMLImageElement>(".copy-button img"),
		urlInput: app.querySelector<HTMLInputElement>(".url-input"),
		settingsButton: app.querySelector<HTMLButtonElement>(".settings-button"),
		modal: app.querySelector<HTMLDivElement>("#settings-modal"),
		closeModal: app.querySelector<HTMLSpanElement>(".close-modal"),
		defaultBangSelect: app.querySelector<HTMLInputElement>("#default-bang"),
		description: app.querySelector<HTMLLabelElement>("#bang-description"),
		bangName: app.querySelector<HTMLInputElement>(".bang-name"),
		bangShortcut: app.querySelector<HTMLInputElement>(".bang-shortcut"),
		bangSearchUrl: app.querySelector<HTMLInputElement>(".bang-search-url"),
		bangBaseUrl: app.querySelector<HTMLInputElement>(".bang-base-url"),
		addBang: app.querySelector<HTMLButtonElement>(".add-bang"),
		removeBangs: app.querySelectorAll<HTMLButtonElement>(".remove-bang"),
		editBangs: app.querySelectorAll<HTMLButtonElement>(".edit-bang"),
		exportSettings: app.querySelector<HTMLButtonElement>(".export-settings"),
		importSettings: app.querySelector<HTMLButtonElement>(".import-settings"),
		importFile: app.querySelector<HTMLInputElement>("#import-file"),
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

	// Populate search count from the service worker
	requestSearchCount().then((count) => {
		validatedElements.searchCount.textContent = `${count} ${count === 1 ? "search" : "searches"}`;
	});

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
			spin: createAudio("/heavier-tick-sprite.opus"),
			click: createAudio("/click-button.opus"),
			warning: createAudio("/double-button.opus"),
			copy: createAudio("/foot-switch.opus"),
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

		validatedElements.addBang.addEventListener("click", () => {
			audio.click.currentTime = 0.1;
			audio.click.playbackRate = 2;
			audio.click.play();
		});

		validatedElements.removeBangs.forEach((button) => {
			button.addEventListener("click", () => {
				audio.warning.currentTime = 0;
				audio.warning.play();
			});
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
	});

	validatedElements.defaultBangSelect.addEventListener("change", async (event) => {
		const newDefaultBang = (event.target as HTMLInputElement).value.replace(
			/^!+/,
			"",
		);

		const reject = () => {
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
		};

		// Reject empty shortcuts
		if (!newDefaultBang) {
			reject();
			return;
		}

		// Validate against the SW's bang catalog (built-in + custom)
		const exists = await checkBangExists(newDefaultBang);
		if (!exists) {
			reject();
			return;
		}

		validatedElements.defaultBangSelect.dispatchEvent(
			new CustomEvent("bangSuccess"),
		);
		storage.set(CONSTANTS.LOCAL_STORAGE_KEYS.DEFAULT_BANG, newDefaultBang);
		validatedElements.description.innerText = "Default Bang: !" + newDefaultBang;
	});

	validatedElements.addBang.addEventListener("click", () => {
		const name = validatedElements.bangName.value.trim();
		const shortcut = validatedElements.bangShortcut.value
			.trim()
			.replace(/^!+/, "");
		const searchUrl = validatedElements.bangSearchUrl.value.trim();
		const baseUrl = validatedElements.bangBaseUrl.value.trim();

		if (!name || !searchUrl || !baseUrl) return;

		if (editingShortcut && editingShortcut !== shortcut) {
			delete customBangs[editingShortcut];
		}
		customBangs[shortcut] = {
			s: name,
			u: searchUrl,
			d: baseUrl,
		};
		editingShortcut = null;
		storage.set(
			CONSTANTS.LOCAL_STORAGE_KEYS.CUSTOM_BANGS,
			JSON.stringify(customBangs),
		);
		syncCustomBangsToSW();

		if (!prefersReducedMotion)
			setTimeout(() => {
				window.location.reload();
			}, 375);
		else window.location.reload();
	});

	validatedElements.editBangs.forEach((button) => {
		button.addEventListener("click", (event) => {
			const shortcut = (event.target as HTMLButtonElement).dataset
				.shortcut as string;
			const bang = customBangs[shortcut];
			if (!bang) return;

			editingShortcut = shortcut;
			validatedElements.bangName.value = bang.s;
			validatedElements.bangShortcut.value = `!${shortcut}`;
			validatedElements.bangSearchUrl.value = bang.u;
			validatedElements.bangBaseUrl.value = bang.d;
			validatedElements.addBang.textContent = "Update Bang";
		});
	});

	validatedElements.removeBangs.forEach((button) => {
		button.addEventListener("click", (event) => {
			const shortcut = (event.target as HTMLButtonElement).dataset
				.shortcut as string;
			delete customBangs[shortcut];
			storage.set(
				CONSTANTS.LOCAL_STORAGE_KEYS.CUSTOM_BANGS,
				JSON.stringify(customBangs),
			);
			syncCustomBangsToSW();

			if (!prefersReducedMotion)
				setTimeout(() => {
					window.location.reload();
				}, 375);
			else window.location.reload();
		});
	});

	validatedElements.exportSettings.addEventListener("click", () => {
		const settingsData = {
			defaultBang: storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.DEFAULT_BANG),
			customBangs: storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.CUSTOM_BANGS),
			exportDate: new Date().toISOString(),
		};

		const dataStr = JSON.stringify(settingsData, null, 2);
		const dataBlob = new Blob([dataStr], { type: "application/json" });
		const url = URL.createObjectURL(dataBlob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `unduckified-settings-${new Date().toISOString().split("T")[0]}.json`;
		link.click();
		URL.revokeObjectURL(url);
	});

	validatedElements.importSettings.addEventListener("click", () => {
		validatedElements.importFile.click();
	});

	validatedElements.importFile.addEventListener("change", async (event) => {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;

		try {
			const text = await file.text();
			const settingsData = JSON.parse(text);

			if (settingsData.defaultBang) {
				storage.set(
					CONSTANTS.LOCAL_STORAGE_KEYS.DEFAULT_BANG,
					settingsData.defaultBang,
				);
			}
			if (settingsData.customBangs) {
				storage.set(
					CONSTANTS.LOCAL_STORAGE_KEYS.CUSTOM_BANGS,
					settingsData.customBangs,
				);
				// Update local customBangs object and sync to SW
				Object.assign(customBangs, JSON.parse(settingsData.customBangs));
				syncCustomBangsToSW();
			}

			alert("Settings imported successfully!");
			if (!prefersReducedMotion)
				setTimeout(() => {
					window.location.reload();
				}, 375);
			else window.location.reload();
		} catch (error) {
			alert("Failed to import settings. Please check the file format.");
			console.error("Import error:", error);
		}
	});
}

const LS_DEFAULT_BANG =
	storage.get(CONSTANTS.LOCAL_STORAGE_KEYS.DEFAULT_BANG) ?? "ddg";

function checkForRedirect() {
	const url = new URL(window.location.href);
	const pathname = url.pathname.replace(/\/$/, "");
	const query = url.searchParams.get("q")?.trim() ?? "";

	// Unknown path → 404
	if (pathname !== "" && pathname !== "/search") {
		notFoundPageRender();
		return;
	}

	// No query → render homepage
	if (!query || query === "!" || query === "!settings") {
		noSearchDefaultPageRender();
		return;
	}

	// Query exists → SW should handle it (or fallback script already did)
	// If we reach here, something went wrong with SW/fallback
	console.warn("SW/fallback didn't handle redirect, rendering homepage");
	noSearchDefaultPageRender();
}

checkForRedirect();
