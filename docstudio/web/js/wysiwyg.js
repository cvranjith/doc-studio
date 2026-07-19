import { api } from "./api.js";
import { el, toast } from "./util.js";
import { markdownToEditableHtml, htmlToMarkdown } from "./markdown.js";

// A rich-text chapter editor backed by markdown storage: a contenteditable
// region + formatting toolbar (bold/italic/headings/lists/quote/image),
// converted to/from markdown via marked.js (load) and turndown.js (save).
// Pasted images upload to the document's assets/ folder and are referenced
// as relative "assets/<file>" paths in the stored markdown — the same
// convention TemplatedDocFormatter embeds into the Word export with, and
// LLM-generated diagrams would eventually use too.
//
// Falls back to a raw markdown textarea (toggle button) for constructs a
// contenteditable+execCommand editor can't faithfully round-trip, notably
// tables.
export function createWysiwygEditor(slug, initialMarkdown) {
  let sourceMode = false;
  let savedRange = null;

  const editable = el("div", { class: "wysiwyg-body markdown-body", contenteditable: "true" });
  editable.innerHTML = markdownToEditableHtml(initialMarkdown, slug);

  const sourceArea = el("textarea", { class: "wysiwyg-source", style: "display:none;" });

  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editable.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    editable.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }

  function cmd(name, value) {
    editable.focus();
    document.execCommand(name, false, value);
  }

  // mousedown+preventDefault (not click) so the toolbar button never steals
  // focus away from the contenteditable — losing focus loses the selection
  // execCommand needs to act on.
  function toolbarButton(label, title, onAction) {
    return el("button", {
      type: "button",
      class: "wys-btn",
      text: label,
      title,
      onmousedown: (e) => {
        e.preventDefault();
        onAction();
      },
    });
  }

  const imageInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", style: "display:none" });
  imageInput.addEventListener("change", () => {
    if (imageInput.files.length) insertImage(imageInput.files[0]);
    imageInput.value = "";
  });

  async function insertImage(file) {
    try {
      const result = await api.uploadAsset(slug, file);
      restoreSelection();
      document.execCommand("insertHTML", false, `<img src="${result.url}" alt="">`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  const sourceToggleBtn = toolbarButton("</> Source", "Switch to raw markdown — needed for tables", () => toggleSourceMode());

  function toggleSourceMode() {
    if (!sourceMode) {
      sourceArea.value = htmlToMarkdown(editable.innerHTML, slug);
      editable.style.display = "none";
      sourceArea.style.display = "";
      sourceToggleBtn.textContent = "Rich Text";
      sourceToggleBtn.classList.add("active");
    } else {
      editable.innerHTML = markdownToEditableHtml(sourceArea.value, slug);
      editable.style.display = "";
      sourceArea.style.display = "none";
      sourceToggleBtn.textContent = "</> Source";
      sourceToggleBtn.classList.remove("active");
    }
    sourceMode = !sourceMode;
  }

  const toolbar = el("div", { class: "wys-toolbar" }, [
    toolbarButton("B", "Bold", () => cmd("bold")),
    toolbarButton("I", "Italic", () => cmd("italic")),
    toolbarButton("H1", "Heading 1", () => cmd("formatBlock", "H1")),
    toolbarButton("H2", "Heading 2", () => cmd("formatBlock", "H2")),
    toolbarButton("H3", "Heading 3", () => cmd("formatBlock", "H3")),
    toolbarButton("¶", "Paragraph", () => cmd("formatBlock", "P")),
    toolbarButton("•", "Bullet list", () => cmd("insertUnorderedList")),
    toolbarButton("1.", "Numbered list", () => cmd("insertOrderedList")),
    toolbarButton("❝", "Quote", () => cmd("formatBlock", "BLOCKQUOTE")),
    toolbarButton("🖼", "Insert image", () => {
      saveSelection();
      imageInput.click();
    }),
    sourceToggleBtn,
  ]);

  editable.addEventListener("paste", (e) => {
    const clipboard = e.clipboardData || window.clipboardData;
    const items = clipboard.items || [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) insertImage(file);
        return;
      }
    }
    // Non-image paste: insert as plain text so foreign rich-text styling
    // (fonts, colors, MS Word cruft) never leaks into chapter markdown.
    const text = clipboard.getData("text/plain");
    if (text) {
      e.preventDefault();
      cmd("insertText", text);
    }
  });

  const wrapper = el("div", { class: "wysiwyg-editor" }, [toolbar, editable, sourceArea, imageInput]);

  return {
    element: wrapper,
    getMarkdown() {
      return sourceMode ? sourceArea.value : htmlToMarkdown(editable.innerHTML, slug);
    },
    focus() {
      editable.focus();
    },
  };
}
