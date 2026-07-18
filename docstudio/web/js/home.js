import { api } from "./api.js";
import { el, clear, fmtDate, statusBadge, openModal, closeModal, toast } from "./util.js";

export async function renderHome(container, hash) {
  const tab = hash === "/templates" ? "templates" : "documents";

  const tabs = el("div", { class: "tabs" }, [
    el("button", {
      class: tab === "documents" ? "active" : "",
      onclick: () => (location.hash = "#/"),
      text: "Documents",
    }),
    el("button", {
      class: tab === "templates" ? "active" : "",
      onclick: () => (location.hash = "#/templates"),
      text: "Templates",
    }),
  ]);

  const home = el("div", { class: "home" });
  const toolbar = el("div", { class: "home-toolbar" }, [
    el("h1", { text: tab === "documents" ? "Documents" : "Templates" }),
  ]);

  if (tab === "documents") {
    const newBtn = el("button", { class: "primary", text: "+ New Document", onclick: openNewDocumentModal });
    toolbar.appendChild(newBtn);
  } else {
    const uploadBtn = el("button", { class: "primary", text: "Upload Word Template", onclick: openUploadTemplateModal });
    toolbar.appendChild(uploadBtn);
  }

  home.appendChild(tabs);
  home.appendChild(toolbar);

  const contentHost = el("div");
  home.appendChild(contentHost);
  clear(container);
  container.appendChild(home);

  if (tab === "documents") {
    await renderDocumentsGrid(contentHost);
  } else {
    await renderTemplatesGrid(contentHost);
  }
}

async function renderDocumentsGrid(host) {
  host.appendChild(el("div", { class: "empty-hint", text: "Loading…" }));
  let docs;
  try {
    docs = await api.listDocuments();
  } catch (e) {
    clear(host);
    host.appendChild(el("div", { class: "empty-hint", text: "Failed to load documents: " + e.message }));
    return;
  }
  clear(host);
  if (!docs.length) {
    host.appendChild(el("div", { class: "empty-hint", text: "No documents yet — create one to get started." }));
    return;
  }
  const grid = el("div", { class: "doc-grid" });
  for (const doc of docs) {
    grid.appendChild(documentCard(doc));
  }
  host.appendChild(grid);
}

function documentCard(doc) {
  const badges = [statusBadge(doc.status)];
  if (doc.open_questions) {
    badges.push(el("span", { class: "badge oq", text: `${doc.open_questions} open question${doc.open_questions > 1 ? "s" : ""}` }));
  }
  return el("div", { class: "doc-card", onclick: () => (location.hash = `#/doc/${encodeURIComponent(doc.slug)}`) }, [
    el("div", { class: "doc-title", text: doc.title }),
    el("div", { class: "doc-meta" }, [
      el("span", { text: doc.client ? `${doc.doc_type} · ${doc.client}` : doc.doc_type }),
      el("span", { text: `Updated ${fmtDate(doc.updated)}` }),
      el("span", { text: `v${doc.current_version}` }),
    ]),
    el("div", { class: "doc-badges" }, badges),
  ]);
}

async function renderTemplatesGrid(host) {
  host.appendChild(el("div", { class: "empty-hint", text: "Loading…" }));
  const [docTypes, wordTemplates] = await Promise.all([api.listDocTypes(), api.listWordTemplates()]);
  clear(host);

  host.appendChild(el("h2", { text: "Document Type Templates" }));
  host.appendChild(
    el("div", { class: "empty-hint", text: "Each template drives what a new document of that type looks like: its chapters and per-chapter drafting instructions, the clarification interview bank, and the Word template used at export time. Click a card to edit." })
  );
  const dtGrid = el("div", { class: "template-grid" });
  for (const t of docTypes) {
    dtGrid.appendChild(
      el("div", { class: "template-card", onclick: () => openTemplateEditor(t.doc_type) }, [
        el("div", { class: "doc-title", text: t.name }),
        el("div", { class: "doc-meta", text: `${t.doc_type} · v${t.version} · ${t.chapters.length} chapters` }),
        el("div", { class: "doc-meta", text: t.word_template ? `Word template: ${t.word_template}` : "No word template attached" }),
      ])
    );
  }
  host.appendChild(dtGrid);

  host.appendChild(el("h2", { text: "Word Templates", style: "margin-top:20px;" }));
  const wtGrid = el("div", { class: "template-grid" });
  for (const name of wordTemplates) {
    wtGrid.appendChild(el("div", { class: "template-card" }, [el("div", { class: "doc-title", text: name })]));
  }
  host.appendChild(wtGrid);
}

async function openNewDocumentModal() {
  const docTypes = await api.listDocTypes();
  const title = el("input", { type: "text", placeholder: "e.g. Payment Gateway FSD" });
  const select = el(
    "select",
    {},
    docTypes.map((t) => el("option", { value: t.doc_type, text: `${t.name} (${t.doc_type})` }))
  );

  const content = el("div", {}, [
    el("h3", { text: "New Document" }),
    el("div", { class: "field" }, [el("label", { text: "Document Type" }), select]),
    el("div", { class: "field" }, [el("label", { text: "Title" }), title]),
    el("div", { class: "buttons" }, [
      el("button", { text: "Cancel", onclick: closeModal }),
      el("button", {
        class: "primary",
        text: "Create",
        onclick: async () => {
          if (!title.value.trim()) {
            toast("Title is required", true);
            return;
          }
          try {
            const doc = await api.createDocument(title.value.trim(), select.value, "");
            closeModal();
            location.hash = `#/doc/${encodeURIComponent(doc.slug)}`;
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ]),
  ]);
  openModal(content);
}

function openUploadTemplateModal() {
  const fileInput = el("input", { type: "file", accept: ".docx" });
  const content = el("div", {}, [
    el("h3", { text: "Upload Word Template" }),
    el("div", { class: "field" }, [el("label", { text: "Corporate .docx template" }), fileInput]),
    el("div", { class: "buttons" }, [
      el("button", { text: "Cancel", onclick: closeModal }),
      el("button", {
        class: "primary",
        text: "Upload",
        onclick: async () => {
          if (!fileInput.files.length) return;
          try {
            await api.uploadWordTemplate(fileInput.files[0]);
            closeModal();
            toast("Template uploaded");
            location.hash = "#/templates";
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ]),
  ]);
  openModal(content);
}

async function openTemplateEditor(docType) {
  const tpl = await api.getDocType(docType);
  const chapters = tpl.chapters.map((c) => ({ ...c }));
  const interviewBank = tpl.interview_bank.map((q) => ({ ...q, choices: [...(q.choices || [])] }));
  const checklist = [...tpl.quality_checklist];

  const nameInput = el("input", { type: "text", value: tpl.name });
  const versionInput = el("input", { type: "text", value: tpl.version });

  const wordTemplateLabel = el("span", { text: tpl.word_template || "(none attached)" });
  const wordTemplateFile = el("input", { type: "file", accept: ".docx", style: "display:none" });
  wordTemplateFile.addEventListener("change", async () => {
    if (!wordTemplateFile.files.length) return;
    try {
      const updated = await api.attachDocTypeWordTemplate(docType, wordTemplateFile.files[0]);
      wordTemplateLabel.textContent = updated.word_template;
      toast("Word template attached");
    } catch (e) {
      toast(e.message, true);
    }
  });
  const wordTemplateRow = el("div", { class: "word-template-row" }, [
    el("strong", { text: "Word template:" }),
    wordTemplateLabel,
    el("button", { class: "small", text: "Replace…", onclick: () => wordTemplateFile.click() }),
    wordTemplateFile,
  ]);

  const chaptersHost = el("div", {});
  function renderChapters() {
    clear(chaptersHost);
    chapters.forEach((c, idx) => chaptersHost.appendChild(chapterRow(c, idx)));
  }
  function chapterRow(c, idx) {
    const numberInput = el("input", { class: "number", type: "text", value: c.number });
    const titleInput = el("input", { type: "text", value: c.title });
    const requiredCb = el("input", { type: "checkbox", checked: c.required || undefined });
    const derivedCb = el("input", { type: "checkbox", checked: c.derived || undefined });
    const promptTa = el("textarea", { text: c.prompt });
    numberInput.addEventListener("change", () => (c.number = numberInput.value.trim()));
    titleInput.addEventListener("change", () => (c.title = titleInput.value.trim()));
    requiredCb.addEventListener("change", () => (c.required = requiredCb.checked));
    derivedCb.addEventListener("change", () => (c.derived = derivedCb.checked));
    promptTa.addEventListener("input", () => (c.prompt = promptTa.value));

    const upBtn = el("button", {
      class: "small",
      text: "↑",
      onclick: () => {
        if (idx > 0) {
          [chapters[idx - 1], chapters[idx]] = [chapters[idx], chapters[idx - 1]];
          renderChapters();
        }
      },
    });
    const downBtn = el("button", {
      class: "small",
      text: "↓",
      onclick: () => {
        if (idx < chapters.length - 1) {
          [chapters[idx + 1], chapters[idx]] = [chapters[idx], chapters[idx + 1]];
          renderChapters();
        }
      },
    });
    const delBtn = el("button", {
      class: "small danger",
      text: "Delete",
      onclick: () => {
        chapters.splice(idx, 1);
        renderChapters();
      },
    });

    return el("div", { class: "tpl-chapter" }, [
      el("div", { class: "row" }, [
        numberInput,
        titleInput,
        el("label", { class: "check" }, [requiredCb, "required"]),
        el("label", { class: "check" }, [derivedCb, "derived"]),
        upBtn,
        downBtn,
        delBtn,
      ]),
      promptTa,
    ]);
  }
  renderChapters();
  const addChapterBtn = el("button", {
    text: "+ Add Chapter",
    onclick: () => {
      chapters.push({ number: String(chapters.length + 1).padStart(2, "0"), title: "New Chapter", required: true, derived: false, prompt: "" });
      renderChapters();
    },
  });

  const iqHost = el("div", {});
  function renderIQ() {
    clear(iqHost);
    interviewBank.forEach((q, idx) => iqHost.appendChild(iqRow(q, idx)));
  }
  function iqRow(q, idx) {
    const qInput = el("input", { type: "text", value: q.q, placeholder: "Question text" });
    const chapterInput = el("input", { type: "text", value: q.chapter, placeholder: "Chapter #", style: "max-width:90px;" });
    const choicesInput = el("input", {
      type: "text",
      value: (q.choices || []).join(", "),
      placeholder: "Choices, comma-separated (blank = free text)",
    });
    const contextInput = el("input", {
      type: "text",
      value: q.context || "",
      placeholder: "Pretext shown to the consultant — why this is being asked (optional)",
    });
    qInput.addEventListener("change", () => (q.q = qInput.value));
    chapterInput.addEventListener("change", () => (q.chapter = chapterInput.value.trim()));
    choicesInput.addEventListener("change", () => (q.choices = choicesInput.value.split(",").map((s) => s.trim()).filter(Boolean)));
    contextInput.addEventListener("change", () => (q.context = contextInput.value));
    const delBtn = el("button", {
      class: "small danger",
      text: "Delete",
      onclick: () => {
        interviewBank.splice(idx, 1);
        renderIQ();
      },
    });
    return el("div", { class: "tpl-iq" }, [
      el("div", { class: "row" }, [qInput, delBtn]),
      el("div", { class: "row" }, [chapterInput, choicesInput]),
      el("div", { class: "row" }, [contextInput]),
    ]);
  }
  renderIQ();
  const addIQBtn = el("button", {
    text: "+ Add Question",
    onclick: () => {
      interviewBank.push({ q: "", chapter: chapters[0] ? chapters[0].number : "01", choices: [], context: "" });
      renderIQ();
    },
  });

  const clHost = el("div", {});
  function renderChecklist() {
    clear(clHost);
    checklist.forEach((item, idx) => {
      const input = el("input", { type: "text", value: item });
      input.addEventListener("change", () => (checklist[idx] = input.value));
      const delBtn = el("button", {
        class: "small danger",
        text: "×",
        onclick: () => {
          checklist.splice(idx, 1);
          renderChecklist();
        },
      });
      clHost.appendChild(el("div", { class: "tpl-checklist-row" }, [input, delBtn]));
    });
  }
  renderChecklist();
  const addChecklistBtn = el("button", {
    text: "+ Add Item",
    onclick: () => {
      checklist.push("");
      renderChecklist();
    },
  });

  const content = el("div", {}, [
    el("h3", { text: `Edit Template — ${tpl.doc_type}` }),
    el("div", { class: "field" }, [el("label", { text: "Name" }), nameInput]),
    el("div", { class: "field" }, [el("label", { text: "Version" }), versionInput]),
    wordTemplateRow,
    el("div", { class: "tpl-section" }, [el("h4", { text: "Chapters" }), chaptersHost, addChapterBtn]),
    el("div", { class: "tpl-section" }, [el("h4", { text: "Interview Bank" }), iqHost, addIQBtn]),
    el("div", { class: "tpl-section" }, [el("h4", { text: "Quality Checklist" }), clHost, addChecklistBtn]),
    el("div", { class: "buttons" }, [
      el("button", { text: "Cancel", onclick: closeModal }),
      el("button", {
        class: "primary",
        text: "Save Template",
        onclick: async () => {
          try {
            await api.saveDocType(docType, {
              name: nameInput.value.trim(),
              version: versionInput.value.trim(),
              word_template: wordTemplateLabel.textContent === "(none attached)" ? "" : wordTemplateLabel.textContent,
              chapters,
              interview_bank: interviewBank,
              quality_checklist: checklist.filter((c) => c.trim()),
            });
            toast("Template saved");
            closeModal();
            location.hash = "#/templates";
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ]),
  ]);
  openModal(content, { wide: true });
}
