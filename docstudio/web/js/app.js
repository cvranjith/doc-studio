import { renderHome } from "./home.js";
import { renderDocumentView } from "./document.js";
import { clear, el } from "./util.js";

const root = document.getElementById("app");

function route() {
  const hash = location.hash.slice(1) || "/";
  clear(root);

  const topbar = el("div", { class: "topbar" }, [
    el("span", { class: "brand", onclick: () => (location.hash = "#/") }, "Document Studio"),
  ]);

  const m = hash.match(/^\/doc\/([^/]+)$/);
  if (m) {
    root.appendChild(topbar);
    const body = el("div", { style: "flex:1; display:flex; flex-direction:column; overflow:hidden;" });
    root.appendChild(body);
    renderDocumentView(body, decodeURIComponent(m[1]));
    return;
  }

  root.appendChild(topbar);
  const body = el("div", { style: "flex:1; overflow:hidden;" });
  root.appendChild(body);
  renderHome(body, hash);
}

window.addEventListener("hashchange", route);
route();
