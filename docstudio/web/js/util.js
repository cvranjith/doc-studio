export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function toast(message, isError = false) {
  const root = document.getElementById("toast-root");
  const node = el("div", { class: "toast", text: message });
  if (isError) node.style.background = "#c0392b";
  root.appendChild(node);
  setTimeout(() => node.remove(), 3500);
}

export function openModal(contentNode, { wide = false } = {}) {
  const backdrop = el("div", { class: "modal-backdrop" }, [
    el("div", { class: wide ? "modal modal-wide" : "modal" }, [contentNode]),
  ]);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  const root = document.getElementById("modal-root");
  clear(root);
  root.appendChild(backdrop);
  return backdrop;
}

export function closeModal() {
  clear(document.getElementById("modal-root"));
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function statusBadge(status) {
  return el("span", { class: `badge status-${status}`, text: status });
}

// Word-template {VARIABLE} tokens computed automatically at export time
// (creation date, export filename) — never shown in a fill-in form.
// Mirrors docstudio/formatter/templated.py::SYSTEM_VARIABLES.
export const SYSTEM_TEMPLATE_VARIABLES = new Set(["CREATION_ON", "DOC_NAME"]);

// Shared row-builder for a {VARIABLE} fill-in form, used by both the New
// Document wizard and the document view's Variables popup.
export function variableFields(names, values, inputs) {
  return names.map((name) => {
    const input = el("input", { type: "text", value: values[name] || "" });
    inputs[name] = input;
    return el("div", { class: "field" }, [el("label", { text: name }), input]);
  });
}
