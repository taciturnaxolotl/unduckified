import { CONSTANTS } from "./main";

const createTemplate = () => `
 <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
  <div class="content-container">
   <h1 id="cutie">${CONSTANTS.CUTIES.NOTFOUND[Math.floor(Math.random() * CONSTANTS.CUTIES.NOTFOUND.length)]}</h1>
   <p>404 Page not found</p>
  </div>
  <footer class="footer">
   made with ♥ by <a href="https://github.com/taciturnaxolotl" target="_blank">Kieran Klukas</a> as <a href="https://github.com/taciturnaxolotl/unduck" target="_blank">open source</a> software
  </footer>
 </div>
`;

export default function notFoundPageRender() {
	const app = document.querySelector<HTMLDivElement>("#app");
	if (!app) throw new Error("App element not found");

	app.innerHTML = createTemplate();
}
