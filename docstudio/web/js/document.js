import { api } from "./api.js";
import { el, clear, fmtDate, statusBadge, openModal, closeModal, toast, SYSTEM_TEMPLATE_VARIABLES, variableFields } from "./util.js";
import { renderInto } from "./markdown.js";
import { renderSourcesPane } from "./sources.js";
import { renderConversationPane, runInstruction } from "./conversation.js";
import { createWysiwygEditor } from "./wysiwyg.js";

// Per-document UI preferences (collapse state, active left tab, focused
// chapter) survive a reloadAll() within the same browser session — they are
// not persisted to disk, just kept in memory keyed by slug.
const uiState = new Map();

export async function renderDocumentView(container, slug) {
  clear(container);
  container.appendChild(el("div", { class: "empty-hint", text: "Loading…" }));

  let data;
  try {
    data = await api.getDocument(slug);
  } catch (e) {
    clear(container);
    container.appendChild(el("div", { class: "empty-hint", text: "Document not found: " + e.message }));
    return;
  }
  clear(container);

  if (!uiState.has(slug)) {
    uiState.set(slug, { leftCollapsed: false, rightCollapsed: false, activeLeftTab: "sources", focusedChapterFile: null });
  }
  const prefs = uiState.get(slug);
  if (!data.manifest.chapters.some((c) => c.file === prefs.focusedChapterFile)) {
    prefs.focusedChapterFile = null;
  }

  const ctx = {
    slug,
    manifest: data.manifest,
    docType: data.doc_type_template,
    checkedSourceIds: new Set(),
    chapterHandlers: new Map(),
    prefs,
    reloadAll: () => renderDocumentView(container, slug),
  };

  // A New Document wizard may have queued an initial instruction (§ home.js)
  // — consume it once, pre-checking whatever sources it named so the
  // Sources pane reflects the same scope the auto-triggered instruction uses.
  const pendingKey = `docstudio:pendingInstruction:${slug}`;
  let pendingInstruction = null;
  const pendingRaw = sessionStorage.getItem(pendingKey);
  if (pendingRaw) {
    sessionStorage.removeItem(pendingKey);
    try {
      const pending = JSON.parse(pendingRaw);
      pendingInstruction = pending.instruction;
      ctx.checkedSourceIds = new Set(pending.checkedSourceIds || []);
    } catch (e) {
      /* ignore malformed sessionStorage entry */
    }
  }

  const header = el("div", { class: "doc-header" });
  container.appendChild(header);

  const workspace = el("div", { class: "workspace" });
  container.appendChild(workspace);

  const leftPane = el("div", { class: "pane" });
  const middlePane = el("div", { class: "pane" });
  const rightPane = el("div", { class: "pane" });
  workspace.appendChild(leftPane);
  workspace.appendChild(middlePane);
  workspace.appendChild(rightPane);

  function applyCollapseState() {
    leftPane.classList.toggle("collapsed", prefs.leftCollapsed);
    rightPane.classList.toggle("collapsed", prefs.rightCollapsed);
    workspace.style.gridTemplateColumns = `${prefs.leftCollapsed ? "36px" : "280px"} 1fr ${prefs.rightCollapsed ? "36px" : "380px"}`;
  }

  // -- left pane: tabbed (Sources / Chapters), collapsible --------------

  const leftChrome = el("div", { class: "pane-chrome" });
  const leftBody = el("div", { class: "pane-body" });
  const tabSourcesBtn = el("button", { text: "Sources", onclick: () => { prefs.activeLeftTab = "sources"; renderLeftTab(); } });
  const tabChaptersBtn = el("button", { text: "Chapters", onclick: () => { prefs.activeLeftTab = "chapters"; renderLeftTab(); } });
  const leftCollapseBtn = el("button", {
    class: "collapse-btn",
    text: prefs.leftCollapsed ? "»" : "«",
    onclick: () => {
      prefs.leftCollapsed = !prefs.leftCollapsed;
      leftCollapseBtn.textContent = prefs.leftCollapsed ? "»" : "«";
      applyCollapseState();
    },
  });
  leftChrome.appendChild(el("div", { class: "pane-tabs" }, [tabSourcesBtn, tabChaptersBtn]));
  leftChrome.appendChild(leftCollapseBtn);
  leftPane.appendChild(leftChrome);
  leftPane.appendChild(leftBody);

  function renderLeftTab() {
    tabSourcesBtn.classList.toggle("active", prefs.activeLeftTab === "sources");
    tabChaptersBtn.classList.toggle("active", prefs.activeLeftTab === "chapters");
    clear(leftBody);
    if (prefs.activeLeftTab === "sources") renderSourcesPane(leftBody, ctx);
    else renderChaptersTab(leftBody, ctx);
  }

  // -- middle pane: the document itself ----------------------------------

  const middleChrome = el("div", { class: "pane-chrome" }, [el("div", { class: "pane-title", text: "Document" })]);
  const middleBody = el("div", { class: "pane-body" });
  middlePane.appendChild(middleChrome);
  middlePane.appendChild(middleBody);
  ctx.rerenderMiddle = () => renderChapters(middleBody, ctx);

  // -- right pane: conversation / iterate, collapsible --------------------

  const rightChrome = el("div", { class: "pane-chrome" });
  const rightBody = el("div", { class: "pane-body" });
  const rightCollapseBtn = el("button", {
    class: "collapse-btn",
    text: prefs.rightCollapsed ? "«" : "»",
    onclick: () => {
      prefs.rightCollapsed = !prefs.rightCollapsed;
      rightCollapseBtn.textContent = prefs.rightCollapsed ? "«" : "»";
      applyCollapseState();
    },
  });
  rightChrome.appendChild(el("div", { class: "pane-title", text: "Conversation" }));
  rightChrome.appendChild(rightCollapseBtn);
  rightPane.appendChild(rightChrome);
  rightPane.appendChild(rightBody);

  // -- shared behavior ------------------------------------------------

  ctx.refreshManifest = async () => {
    const fresh = await api.getDocument(slug);
    ctx.manifest = fresh.manifest;
    renderHeader(header, ctx);
    for (const c of ctx.manifest.chapters) {
      const h = ctx.chapterHandlers.get(c.file);
      if (h) {
        h.setStatus(c.status);
        h.setOpenQuestions(c.open_questions);
      }
    }
    if (prefs.activeLeftTab === "chapters") renderLeftTab();
  };

  ctx.focusChapter = (file) => {
    prefs.focusedChapterFile = file;
    ctx.rerenderMiddle();
    if (prefs.activeLeftTab === "chapters") renderLeftTab();
    if (ctx.setScope) ctx.setScope(file || "document");
    if (ctx.focusInstructBox) ctx.focusInstructBox();
  };

  renderHeader(header, ctx);
  applyCollapseState();
  renderLeftTab();
  renderConversationPane(rightBody, ctx);
  if (prefs.focusedChapterFile && ctx.setScope) ctx.setScope(prefs.focusedChapterFile);
  await renderChapters(middleBody, ctx);

  if (pendingInstruction) {
    await runInstruction(ctx, pendingInstruction, "document");
  }
}

function renderHeader(header, ctx) {
  clear(header);
  const m = ctx.manifest;

  const titleInput = el("input", { class: "title-input", type: "text", value: m.title });
  titleInput.addEventListener("change", async () => {
    try {
      await api.updateDocument(ctx.slug, { title: titleInput.value });
      toast("Title saved");
    } catch (e) {
      toast(e.message, true);
    }
  });

  header.appendChild(titleInput);
  header.appendChild(el("span", { class: "badge", text: m.doc_type }));
  header.appendChild(statusBadge(m.status));
  const openQuestions = countOpenQuestions(m);
  if (openQuestions) {
    header.appendChild(el("span", { class: "badge oq", text: `${openQuestions} open questions` }));
  }
  header.appendChild(el("span", { style: "color:var(--text-muted); font-size:12px;", text: `v${m.current_version}` }));

  const actions = el("div", { class: "actions" }, [
    el("button", { text: "Save Version", onclick: () => saveVersion(ctx) }),
    el("button", { text: "Variables", onclick: () => openVariablesModal(ctx) }),
    el("button", { text: "Export to Word", onclick: () => openExportModal(ctx) }),
    el("button", { text: "Publish to Knowledge Base", onclick: () => publish(ctx) }),
    el("button", { text: "History", onclick: () => openHistoryModal(ctx) }),
    el("button", { class: "danger", text: "Delete Document", onclick: () => deleteDocument(ctx) }),
  ]);
  header.appendChild(actions);
}

async function openVariablesModal(ctx) {
  const docType = await api.getDocType(ctx.manifest.doc_type);
  const userVars = (docType.template_variables || []).filter((v) => !SYSTEM_TEMPLATE_VARIABLES.has(v));

  if (!userVars.length) {
    openModal(
      el("div", {}, [
        el("h3", { text: "Word Template Variables" }),
        el("div", {
          class: "empty-hint",
          text: docType.word_template
            ? `The "${docType.word_template}" template attached to this document type has no {VARIABLE} placeholders to fill in.`
            : "This document type has no Word template attached yet — attach one from the Templates tab first.",
        }),
        el("div", { class: "buttons" }, [el("button", { text: "Close", onclick: closeModal })]),
      ])
    );
    return;
  }

  const inputs = {};
  const fields = variableFields(userVars, ctx.manifest.variables || {}, inputs);

  const content = el("div", {}, [
    el("h3", { text: "Word Template Variables" }),
    el("div", {
      class: "empty-hint",
      text: `Fills in {VARIABLE} placeholders in the "${docType.word_template}" template at export time.`,
    }),
    ...fields,
    el("div", { class: "buttons" }, [
      el("button", { text: "Cancel", onclick: closeModal }),
      el("button", {
        class: "primary",
        text: "Save",
        onclick: async () => {
          const variables = { ...ctx.manifest.variables };
          for (const name of userVars) variables[name] = inputs[name].value.trim();
          try {
            await api.updateDocument(ctx.slug, { variables });
            ctx.manifest.variables = variables;
            toast("Variables saved");
            closeModal();
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ]),
  ]);
  openModal(content);
}

async function deleteDocument(ctx) {
  if (!confirm(`Delete "${ctx.manifest.title}"? This permanently removes it and all its chapters, sources, and versions from disk. This cannot be undone.`)) return;
  try {
    await api.deleteDocument(ctx.slug);
    toast(`Deleted "${ctx.manifest.title}"`);
    location.hash = "#/";
  } catch (e) {
    toast(e.message, true);
  }
}

function countOpenQuestions(manifest) {
  return manifest.chapters.reduce((sum, c) => sum + (c.open_questions || 0), 0);
}

async function saveVersion(ctx) {
  try {
    const info = await api.saveVersion(ctx.slug);
    toast(`Saved as v${info.version}`);
    await ctx.refreshManifest();
  } catch (e) {
    toast(e.message, true);
  }
}

async function publish(ctx) {
  try {
    const res = await api.publish(ctx.slug);
    toast(`Published v${res.version} to knowledge base`);
    await ctx.refreshManifest();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// Chapters tab (left pane): reorderable list, add/delete, click to focus
// ---------------------------------------------------------------------------

function renderChaptersTab(host, ctx) {
  clear(host);
  const list = el("div", {});
  host.appendChild(list);
  let dragSrcFile = null;

  function renderList() {
    clear(list);
    ctx.manifest.chapters.forEach((c) => {
      const row = el(
        "div",
        {
          class: "chapter-row" + (ctx.prefs.focusedChapterFile === c.file ? " focused" : ""),
          draggable: "true",
          onclick: () => ctx.focusChapter(ctx.prefs.focusedChapterFile === c.file ? null : c.file),
        },
        [
          el("span", { class: "drag-handle", text: "⋮⋮" }),
          el("span", { class: "row-title", text: c.title }),
          c.open_questions ? el("span", { class: "badge oq", text: String(c.open_questions) }) : null,
          el("span", { class: `badge status-${c.status}`, text: c.status }),
          el("button", {
            class: "small danger",
            text: "×",
            title: "Delete chapter",
            onclick: (e) => {
              e.stopPropagation();
              deleteChapter(ctx, c.file);
            },
          }),
        ]
      );
      row.addEventListener("dragstart", (e) => {
        dragSrcFile = c.file;
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        row.classList.remove("drag-over");
        if (!dragSrcFile || dragSrcFile === c.file) return;
        const order = ctx.manifest.chapters.map((x) => x.file);
        const from = order.indexOf(dragSrcFile);
        const to = order.indexOf(c.file);
        order.splice(from, 1);
        order.splice(to, 0, dragSrcFile);
        try {
          const updated = await api.reorderChapters(ctx.slug, order);
          ctx.manifest.chapters = updated.chapters;
          renderList();
          ctx.rerenderMiddle();
        } catch (err) {
          toast(err.message, true);
        }
      });
      list.appendChild(row);
    });
  }
  renderList();

  const addInput = el("input", { type: "text", placeholder: "New chapter title…" });
  const addBtn = el("button", {
    class: "primary small",
    text: "+ Add",
    onclick: async () => {
      const title = addInput.value.trim();
      if (!title) return;
      try {
        await api.addChapter(ctx.slug, title);
        addInput.value = "";
        await ctx.reloadAll();
      } catch (e) {
        toast(e.message, true);
      }
    },
  });
  host.appendChild(el("div", { class: "add-chapter-row" }, [addInput, addBtn]));
}

async function deleteChapter(ctx, file) {
  if (!confirm("Delete this chapter? It can only be recovered by restoring a saved version that still has it.")) return;
  try {
    await api.deleteChapter(ctx.slug, file);
    if (ctx.prefs.focusedChapterFile === file) ctx.prefs.focusedChapterFile = null;
    await ctx.reloadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// Chapters (middle pane) — all, or focused on one
// ---------------------------------------------------------------------------

async function renderChapters(pane, ctx) {
  clear(pane);
  ctx.chapterHandlers.clear();

  const focused = ctx.prefs.focusedChapterFile
    ? ctx.manifest.chapters.find((c) => c.file === ctx.prefs.focusedChapterFile)
    : null;

  if (focused) {
    pane.appendChild(
      el("div", { class: "focus-banner" }, [
        el("span", { text: `Focused on “${focused.title}”` }),
        el("span", { class: "spacer" }),
        el("button", { class: "small", text: "Show all chapters", onclick: () => ctx.focusChapter(null) }),
      ])
    );
    pane.appendChild(buildChapterCard(ctx, focused));
    return;
  }

  for (const chapterRef of ctx.manifest.chapters) {
    pane.appendChild(buildChapterCard(ctx, chapterRef));
  }
}

function buildChapterCard(ctx, chapterRef) {
  const card = el("div", { class: "chapter-card" });
  const statusPill = statusBadge(chapterRef.status);
  const oqBadgeSlot = el("span", {});
  const head = el("div", { class: "chapter-head" }, [
    el("span", { class: "title", text: chapterRef.title }),
    oqBadgeSlot,
    statusPill,
  ]);
  const bodyEl = el("div", { class: "chapter-body markdown-body" });
  const actions = el("div", { class: "actions" });

  card.appendChild(head);
  card.appendChild(bodyEl);
  card.appendChild(actions);

  api
    .getChapter(ctx.slug, chapterRef.file)
    .then((chapter) => renderInto(bodyEl, chapter.body, ctx.slug))
    .catch(() => {
      bodyEl.textContent = "Failed to load chapter.";
    });

  if (chapterRef.derived) {
    actions.appendChild(
      el("button", {
        text: "Refresh",
        onclick: () => runInstruction(ctx, "Refresh the glossary from the current chapters.", chapterRef.file),
      })
    );
  } else {
    actions.appendChild(
      el("button", {
        text: "Iterate",
        title: "Focus this chapter and use the Conversation pane on the right to iterate",
        onclick: () => ctx.focusChapter(chapterRef.file),
      })
    );
    actions.appendChild(
      el("button", {
        text: "Regenerate",
        onclick: () => runInstruction(ctx, "Regenerate this chapter from scratch.", chapterRef.file),
      })
    );
  }

  actions.appendChild(el("button", { text: "Edit", onclick: () => openEditor(ctx, chapterRef, bodyEl) }));
  actions.appendChild(el("button", { text: "Mark reviewed", onclick: () => markStatus(ctx, chapterRef.file, "reviewed") }));
  actions.appendChild(el("button", { class: "primary", text: "Mark final", onclick: () => markStatus(ctx, chapterRef.file, "final") }));
  actions.appendChild(
    el("button", { class: "danger", text: "Delete", onclick: () => deleteChapter(ctx, chapterRef.file) })
  );

  let streaming = false;
  let buffer = "";

  const handler = {
    onDelta: (chunk) => {
      if (!streaming) {
        streaming = true;
        buffer = "";
        bodyEl.classList.add("streaming");
        bodyEl.textContent = "";
      }
      buffer += chunk;
      bodyEl.textContent = buffer;
    },
    onComplete: (fullMarkdown) => {
      streaming = false;
      bodyEl.classList.remove("streaming");
      renderInto(bodyEl, fullMarkdown, ctx.slug);
    },
    setStatus: (status) => {
      statusPill.textContent = status;
      statusPill.className = `badge status-${status}`;
    },
    setOpenQuestions: (n) => {
      clear(oqBadgeSlot);
      if (n) oqBadgeSlot.appendChild(el("span", { class: "badge oq", text: `${n} open` }));
    },
  };
  handler.setOpenQuestions(chapterRef.open_questions);
  ctx.chapterHandlers.set(chapterRef.file, handler);

  return card;
}

async function markStatus(ctx, file, status) {
  try {
    await api.saveChapter(ctx.slug, file, { status });
    const h = ctx.chapterHandlers.get(file);
    if (h) h.setStatus(status);
    await ctx.refreshManifest();
  } catch (e) {
    toast(e.message, true);
  }
}

function openEditor(ctx, chapterRef, bodyEl) {
  api.getChapter(ctx.slug, chapterRef.file).then((chapter) => {
    const editor = createWysiwygEditor(ctx.slug, chapter.body);

    const controls = el("div", { class: "actions" }, [
      el("button", {
        text: "Cancel",
        onclick: async () => {
          editor.element.remove();
          controls.remove();
          renderInto(bodyEl, chapter.body, ctx.slug);
          bodyEl.style.display = "";
        },
      }),
      el("button", {
        class: "primary",
        text: "Save",
        onclick: async () => {
          try {
            const updated = await api.saveChapter(ctx.slug, chapterRef.file, { body: editor.getMarkdown() });
            editor.element.remove();
            controls.remove();
            renderInto(bodyEl, updated.body, ctx.slug);
            bodyEl.style.display = "";
            toast("Chapter saved");
            await ctx.refreshManifest();
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ]);

    bodyEl.style.display = "none";
    bodyEl.insertAdjacentElement("afterend", controls);
    bodyEl.insertAdjacentElement("afterend", editor.element);
    editor.focus();
  });
}

// ---------------------------------------------------------------------------
// Export modal
// ---------------------------------------------------------------------------

async function openExportModal(ctx) {
  const templates = await api.listWordTemplates();
  const defaultTemplate = ctx.docType && ctx.docType.word_template;
  const select = el(
    "select",
    {},
    templates.map((t) => el("option", { value: t, text: t, selected: t === defaultTemplate || undefined }))
  );
  const resultHost = el("div", {});

  const content = el("div", {}, [
    el("h3", { text: "Export to Word" }),
    el("div", { class: "field" }, [el("label", { text: "Word Template" }), select]),
    resultHost,
    el("div", { class: "buttons" }, [
      el("button", { text: "Close", onclick: closeModal }),
      el("button", {
        class: "primary",
        text: "Export",
        onclick: () => doExport(ctx, select.value, false, false, resultHost),
      }),
    ]),
  ]);
  openModal(content);
}

async function doExport(ctx, wordTemplate, confirm, forceDraft, host) {
  clear(host);
  try {
    const res = await api.export(ctx.slug, { word_template: wordTemplate, confirm, force_draft_watermark: forceDraft });
    if (res.status === "needs_confirmation") {
      host.appendChild(
        el("div", { class: "field" }, [
          el("label", { text: "This export has open items:" }),
          el("ul", {}, res.warnings.map((w) => el("li", { text: w }))),
          el("button", {
            class: "primary",
            text: "Export as DRAFT (watermarked)",
            onclick: () => doExport(ctx, wordTemplate, true, true, host),
          }),
        ])
      );
      return;
    }
    host.appendChild(
      el("div", { class: "field" }, [
        el("div", { text: res.draft_watermark ? "Exported as DRAFT." : "Exported." }),
        el("a", { href: res.download_url, text: "Download " + res.file, target: "_blank" }),
      ])
    );
    await ctx.refreshManifest();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// History modal
// ---------------------------------------------------------------------------

async function openHistoryModal(ctx) {
  const versions = await api.listVersions(ctx.slug);
  showVersionList(ctx, versions);
}

function showVersionList(ctx, versions) {
  const rows = versions
    .slice()
    .reverse()
    .map((v) =>
      el("div", { class: "version-row" }, [
        el("span", { class: "v-num", text: `v${v.version}` }),
        el("span", { text: fmtDate(v.created) }),
        el("span", { class: "spacer" }),
        el("button", { class: "small", text: "View & Diff", onclick: () => showVersionDetail(ctx, v, versions) }),
        el("button", {
          class: "small danger",
          text: "Restore",
          onclick: async () => {
            if (!confirm(`Restore v${v.version}? Current state will be auto-saved first.`)) return;
            try {
              await api.restore(ctx.slug, v.version);
              closeModal();
              toast(`Restored v${v.version}`);
              ctx.reloadAll();
            } catch (e) {
              toast(e.message, true);
            }
          },
        }),
      ])
    );

  const content = el("div", {}, [
    el("h3", { text: "Version History" }),
    versions.length ? el("div", {}, rows) : el("div", { class: "empty-hint", text: "No saved versions yet." }),
    el("div", { class: "buttons" }, [el("button", { text: "Close", onclick: closeModal })]),
  ]);
  openModal(content);
}

async function showVersionDetail(ctx, version, allVersions) {
  const chapterSelect = el(
    "select",
    {},
    ctx.manifest.chapters.map((c) => el("option", { value: c.file, text: c.title }))
  );
  const viewHost = el("div", {});
  const diffHost = el("div", {});

  async function load() {
    clear(viewHost);
    clear(diffHost);
    const file = chapterSelect.value;
    try {
      const chapter = await api.getVersionChapter(ctx.slug, version.version, file);
      const rendered = el("div", { class: "markdown-body" });
      renderInto(rendered, chapter.body, ctx.slug);
      viewHost.appendChild(el("h4", { text: `v${version.version} (read-only)` }));
      viewHost.appendChild(rendered);
    } catch (e) {
      viewHost.appendChild(el("div", { class: "empty-hint", text: "Not present in this version." }));
    }
    try {
      const diff = await api.diffChapter(ctx.slug, version.version, file);
      diffHost.appendChild(el("h4", { text: "Diff vs current" }));
      diffHost.appendChild(renderDiff(diff.diff));
    } catch (e) {
      /* ignore */
    }
  }
  chapterSelect.addEventListener("change", load);

  const content = el("div", {}, [
    el("h3", { text: `Version v${version.version} — ${fmtDate(version.created)}` }),
    el("div", { class: "field" }, [el("label", { text: "Chapter" }), chapterSelect]),
    viewHost,
    diffHost,
    el("div", { class: "buttons" }, [
      el("button", { text: "Back", onclick: () => showVersionList(ctx, allVersions) }),
      el("button", { text: "Close", onclick: closeModal }),
    ]),
  ]);
  openModal(content);
  await load();
}

function renderDiff(diffText) {
  if (!diffText || !diffText.trim()) {
    return el("div", { class: "empty-hint", text: "No differences." });
  }
  const container = el("div", {});
  for (const line of diffText.split("\n")) {
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "hunk";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    container.appendChild(el("div", { class: `diff-line ${cls}`, text: line || " " }));
  }
  return container;
}
