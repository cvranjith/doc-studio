import { api } from "./api.js";
import { el, clear, openModal, closeModal, toast } from "./util.js";

const EMBED_ELIGIBLE = [".xlsx", ".csv"];

export function renderSourcesPane(pane, ctx) {
  clear(pane);

  const dropzone = el("div", { class: "dropzone" }, "Drag files here or click to upload\n(pdf, docx, xlsx, csv, md, txt, png, jpg)");
  const fileInput = el("input", { type: "file", multiple: true, style: "display:none" });
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    await uploadFiles(ctx, e.dataTransfer.files);
    renderSourcesPane(pane, ctx);
  });
  fileInput.addEventListener("change", async () => {
    await uploadFiles(ctx, fileInput.files);
    renderSourcesPane(pane, ctx);
  });

  pane.appendChild(dropzone);
  pane.appendChild(fileInput);

  const list = el("div", {});
  pane.appendChild(list);

  if (!ctx.manifest.sources.length) {
    list.appendChild(el("div", { class: "empty-hint", text: "No sources yet." }));
  }
  for (const source of ctx.manifest.sources) {
    list.appendChild(sourceItem(pane, ctx, source));
  }
}

async function uploadFiles(ctx, fileList) {
  for (const file of fileList) {
    try {
      await api.uploadSource(ctx.slug, file);
    } catch (e) {
      toast(e.message, true);
    }
  }
  await ctx.refreshManifest();
}

function sourceItem(pane, ctx, source) {
  const checkbox = el("input", {
    type: "checkbox",
    checked: ctx.checkedSourceIds.has(source.id) || undefined,
    onchange: () => {
      if (checkbox.checked) ctx.checkedSourceIds.add(source.id);
      else ctx.checkedSourceIds.delete(source.id);
    },
  });

  const label = el("input", { type: "text", value: source.label });
  label.addEventListener("change", async () => {
    try {
      await api.updateSource(ctx.slug, source.id, { label: label.value });
      await ctx.refreshManifest();
    } catch (e) {
      toast(e.message, true);
    }
  });

  const ext = "." + (source.file.split(".").pop() || "").toLowerCase();
  const canEmbed = EMBED_ELIGIBLE.includes(ext);

  const modeToggle = canEmbed
    ? el("select", {
        onchange: async (e) => {
          try {
            await api.updateSource(ctx.slug, source.id, { mode: e.target.value });
            await ctx.refreshManifest();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, [
        el("option", { value: "source", selected: source.mode === "source" || undefined, text: "source" }),
        el("option", { value: "embed", selected: source.mode === "embed" || undefined, text: "embed" }),
      ])
    : el("span", { class: "meta", text: source.mode });

  const viewBtn = el("button", {
    class: "small",
    text: "View",
    onclick: async () => {
      const res = await api.getExtracted(ctx.slug, source.id);
      openModal(
        el("div", {}, [
          el("h3", { text: source.label }),
          el("pre", { text: res.extracted || `(${res.status}: no extracted text)` }),
          el("div", { class: "buttons" }, [el("button", { text: "Close", onclick: closeModal })]),
        ])
      );
    },
  });

  const deleteBtn = el("button", {
    class: "small danger",
    text: "Delete",
    onclick: async () => {
      if (!confirm(`Delete source "${source.label}"?`)) return;
      try {
        await api.deleteSource(ctx.slug, source.id);
        ctx.checkedSourceIds.delete(source.id);
        await ctx.refreshManifest();
      } catch (e) {
        toast(e.message, true);
      }
    },
  });

  const statusDot = el("span", { class: `status-dot ${source.extraction_status}`, title: source.extraction_status });

  return el("div", { class: "source-item" }, [
    el("div", { class: "row1" }, [checkbox, label]),
    el("div", { class: "meta" }, [statusDot, `${source.file.replace(/^originals\//, "")}`]),
    el("div", { class: "row2" }, [modeToggle, viewBtn, deleteBtn]),
  ]);
}
