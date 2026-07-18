let mermaidInitialized = false;

function ensureMermaid() {
  if (!mermaidInitialized && window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
    mermaidInitialized = true;
  }
}

export function renderMarkdown(text) {
  if (!window.marked) return `<pre>${escapeHtml(text || "")}</pre>`;
  return window.marked.parse(text || "");
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function renderInto(container, text) {
  container.innerHTML = renderMarkdown(text);
  await renderMermaidBlocks(container);
}

async function renderMermaidBlocks(container) {
  const codeBlocks = container.querySelectorAll("code.language-mermaid");
  codeBlocks.forEach((block) => {
    const holder = document.createElement("div");
    holder.className = "mermaid";
    holder.textContent = block.textContent;
    const pre = block.closest("pre") || block;
    pre.replaceWith(holder);
  });

  ensureMermaid();
  if (!window.mermaid) return;
  const mermaidDivs = container.querySelectorAll(".mermaid");
  if (!mermaidDivs.length) return;
  try {
    await window.mermaid.run({ nodes: Array.from(mermaidDivs) });
  } catch (e) {
    console.warn("mermaid render failed", e);
  }
}
