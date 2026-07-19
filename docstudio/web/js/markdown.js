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

// The chapter card header already shows the (H1-synced) chapter title —
// rendering the body's own leading "# Title" line too would show it twice.
// Only used for read-only display; the WYSIWYG editor keeps the heading
// visible/editable since that's how a user renames a chapter.
export function stripLeadingHeading(text) {
  const lines = (text || "").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^#\s+/.test(lines[i].trim())) {
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    return lines.slice(j).join("\n");
  }
  return text;
}

// Chapter markdown references images as relative "assets/<filename>" paths
// (matching the filesystem contract / Word export's own path resolution).
// For on-screen display that needs to become an actual fetchable URL.
export function assetApiUrl(slug, filename) {
  return `/api/documents/${slug}/assets/${filename}`;
}

function rewriteAssetImages(container, slug) {
  if (!slug) return;
  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (src.startsWith("assets/")) {
      img.setAttribute("src", assetApiUrl(slug, src.slice("assets/".length)));
    }
  });
}

export async function renderInto(container, text, slug) {
  container.innerHTML = renderMarkdown(text);
  rewriteAssetImages(container, slug);
  await renderMermaidBlocks(container);
}

// Synchronous variant (no Mermaid pass) for populating an editable region —
// Mermaid's DOM rewriting would fight with the user editing it live.
export function markdownToEditableHtml(text, slug) {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(text);
  rewriteAssetImages(div, slug);
  return div.innerHTML;
}

export function htmlToMarkdown(html, slug) {
  if (!window.TurndownService) return html;
  const td = new window.TurndownService({ headingStyle: "atx", bulletListMarker: "-", hr: "---" });
  const prefix = slug ? assetApiUrl(slug, "") : null;
  td.addRule("chapterImage", {
    filter: "img",
    replacement: (_content, node) => {
      const src = node.getAttribute("src") || "";
      const alt = node.getAttribute("alt") || "";
      const relSrc = prefix && src.startsWith(prefix) ? `assets/${src.slice(prefix.length)}` : src;
      return `![${alt}](${relSrc})`;
    },
  });
  return td.turndown(html);
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
