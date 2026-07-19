import { api } from "./api.js";
import { el, clear, fmtDate, statusBadge, openModal, closeModal, toast, SYSTEM_TEMPLATE_VARIABLES, variableFields } from "./util.js";

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
    const newBtn = el("button", { class: "primary", text: "+ New Document", onclick: openNewDocumentWizard });
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
    grid.appendChild(documentCard(doc, () => renderDocumentsGrid(host)));
  }
  host.appendChild(grid);
}

function documentCard(doc, onDeleted) {
  const badges = [statusBadge(doc.status)];
  if (doc.open_questions) {
    badges.push(el("span", { class: "badge oq", text: `${doc.open_questions} open question${doc.open_questions > 1 ? "s" : ""}` }));
  }
  const deleteBtn = el("button", {
    class: "small danger",
    text: "Delete",
    onclick: async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${doc.title}"? This permanently removes it and all its chapters, sources, and versions from disk. This cannot be undone.`)) return;
      try {
        await api.deleteDocument(doc.slug);
        toast(`Deleted "${doc.title}"`);
        await onDeleted();
      } catch (err) {
        toast(err.message, true);
      }
    },
  });
  return el("div", { class: "doc-card", onclick: () => (location.hash = `#/doc/${encodeURIComponent(doc.slug)}`) }, [
    el("div", { class: "doc-title", text: doc.title }),
    el("div", { class: "doc-meta" }, [
      el("span", { text: doc.client ? `${doc.doc_type} · ${doc.client}` : doc.doc_type }),
      el("span", { text: `Updated ${fmtDate(doc.updated)}` }),
      el("span", { text: `v${doc.current_version}` }),
    ]),
    el("div", { class: "doc-badges" }, badges),
    el("div", { class: "doc-card-actions" }, [deleteBtn]),
  ]);
}

async function renderTemplatesGrid(host) {
  host.appendChild(el("div", { class: "empty-hint", text: "Loading…" }));
  const [docTypes, wordTemplates] = await Promise.all([api.listDocTypes(), api.listWordTemplates()]);
  clear(host);

  const dtHeader = el("div", { class: "home-toolbar", style: "margin:0 0 4px;" }, [
    el("h2", { text: "Document Type Templates", style: "flex:1; margin:0;" }),
    el("button", { class: "small", text: "+ New Template", onclick: () => openNewTemplateModal(() => renderTemplatesGrid(host)) }),
  ]);
  host.appendChild(dtHeader);
  host.appendChild(
    el("div", { class: "empty-hint", text: "Each template drives what a new document of that type looks like: its chapters and per-chapter drafting instructions, the clarification interview bank, and the Word template used at export time. Edit as a form, or as one markdown file (handy for pasting in something LLM-generated)." })
  );
  const dtGrid = el("div", { class: "template-grid" });
  for (const t of docTypes) {
    const editBtn = el("button", { class: "small", text: "Edit", onclick: (e) => { e.stopPropagation(); openTemplateEditor(t.doc_type); } });
    const markdownBtn = el("button", {
      class: "small",
      text: "Edit as Markdown",
      onclick: (e) => { e.stopPropagation(); openTemplateMarkdownEditor(t.doc_type, () => renderTemplatesGrid(host)); },
    });
    const deleteBtn = el("button", {
      class: "small danger",
      text: "Delete",
      onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete template "${t.name}" (${t.doc_type})? This does not affect documents already created from it.`)) return;
        try {
          await api.deleteDocType(t.doc_type);
          toast(`Deleted "${t.name}"`);
          await renderTemplatesGrid(host);
        } catch (err) {
          toast(err.message, true);
        }
      },
    });
    dtGrid.appendChild(
      el("div", { class: "template-card" }, [
        el("div", { class: "doc-title", text: t.name }),
        el("div", { class: "doc-meta", text: `${t.doc_type} · v${t.version} · ${t.chapters.length} chapters` }),
        el("div", { class: "doc-meta", text: t.word_template ? `Word template: ${t.word_template}` : "No word template attached" }),
        el("div", { class: "doc-card-actions", style: "gap:6px;" }, [editBtn, markdownBtn, deleteBtn]),
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

// Four-step wizard: 1) title/type (creates the document immediately so
// later steps have a slug to attach to), 2) word-template {VARIABLE}
// values (skipped automatically if the doc type's template has none),
// 3) optional source uploads, 4) optional initial instruction. Every step
// after the first can be skipped — whatever's skipped is just finished
// later in the document editor, since the document already exists from
// step 1 onward.
async function openNewDocumentWizard() {
  const docTypes = await api.listDocTypes();
  let step = 1;
  let slug = null;
  let selectedDocType = docTypes[0] && docTypes[0].doc_type;
  const uploadedSources = [];
  const variableValues = {};

  const body = el("div", {});
  const content = el("div", {}, [el("h3", { text: "New Document" }), body]);
  openModal(content, { wide: true });

  function wizardProgress(current) {
    const labels = ["1. Details", "2. Variables", "3. Sources", "4. Initial Instruction"];
    return el(
      "div",
      { class: "wizard-steps" },
      labels.map((label, i) =>
        el("span", { class: "wizard-step" + (i + 1 === current ? " active" : i + 1 < current ? " done" : ""), text: label })
      )
    );
  }

  // Loops so a step can "skip itself" (e.g. no variables to fill in) by
  // bumping `step` and returning null, without recursive render calls.
  async function renderStep() {
    clear(body);
    body.appendChild(el("div", { class: "empty-hint", text: "Loading…" }));
    let node = null;
    while (!node) {
      if (step === 1) node = await stepDetails();
      else if (step === 2) node = await stepVariables();
      else if (step === 3) node = await stepSources();
      else node = await stepInstruction();
    }
    clear(body);
    body.appendChild(node);
  }

  async function stepDetails() {
    const title = el("input", { type: "text", placeholder: "e.g. Payment Gateway FSD" });
    const select = el("select", {}, docTypes.map((t) => el("option", { value: t.doc_type, text: `${t.name} (${t.doc_type})` })));
    const nextBtn = el("button", {
      class: "primary",
      text: "Next →",
      onclick: async () => {
        if (!title.value.trim()) {
          toast("Title is required", true);
          return;
        }
        nextBtn.disabled = true;
        try {
          const doc = await api.createDocument(title.value.trim(), select.value, "");
          slug = doc.slug;
          selectedDocType = select.value;
          step = 2;
          renderStep();
        } catch (e) {
          toast(e.message, true);
          nextBtn.disabled = false;
        }
      },
    });
    return el("div", {}, [
      wizardProgress(1),
      el("div", { class: "field" }, [el("label", { text: "Document Type" }), select]),
      el("div", { class: "field" }, [el("label", { text: "Title" }), title]),
      el("div", { class: "buttons" }, [el("button", { text: "Cancel", onclick: closeModal }), nextBtn]),
    ]);
  }

  async function stepVariables() {
    const docType = await api.getDocType(selectedDocType);
    const userVars = (docType.template_variables || []).filter((v) => !SYSTEM_TEMPLATE_VARIABLES.has(v));
    if (!userVars.length) {
      step = 3;
      return null;
    }

    const inputs = {};
    const fields = variableFields(userVars, variableValues, inputs);
    const nextBtn = el("button", {
      class: "primary",
      text: "Next →",
      onclick: async () => {
        for (const name of userVars) variableValues[name] = inputs[name].value.trim();
        try {
          await api.updateDocument(slug, { variables: variableValues });
        } catch (e) {
          toast(e.message, true);
        }
        step = 3;
        renderStep();
      },
    });

    return el("div", {}, [
      wizardProgress(2),
      el("div", {
        class: "empty-hint",
        text: `These fill in {VARIABLE} placeholders in the "${docType.word_template}" Word template attached to this document type.`,
      }),
      ...fields,
      el("div", { class: "buttons" }, [
        el("button", { text: "← Back", onclick: () => { step = 1; renderStep(); } }),
        nextBtn,
      ]),
    ]);
  }

  async function stepSources() {
    const list = el("div", {});
    const dropzone = el("div", { class: "dropzone" }, "Drag files here or click to upload — optional\n(pdf, docx, xlsx, csv, md, txt, png, jpg)");
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
      await handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", () => handleFiles(fileInput.files));

    const nextBtn = el("button", { class: "primary", text: "Skip →", onclick: () => { step = 4; renderStep(); } });

    async function handleFiles(files) {
      for (const file of files) {
        try {
          uploadedSources.push(await api.uploadSource(slug, file));
        } catch (e) {
          toast(e.message, true);
        }
      }
      renderList();
    }

    function renderList() {
      clear(list);
      nextBtn.textContent = uploadedSources.length ? "Next →" : "Skip →";
      if (!uploadedSources.length) {
        list.appendChild(el("div", { class: "empty-hint", text: "No sources uploaded yet — that's fine, you can add them later." }));
        return;
      }
      uploadedSources.forEach((s) => {
        list.appendChild(
          el("div", { class: "source-item" }, [
            el("div", { class: "row1" }, [el("span", { class: `status-dot ${s.extraction_status}` }), el("span", { text: s.label })]),
          ])
        );
      });
    }
    renderList();

    return el("div", {}, [
      wizardProgress(3),
      dropzone,
      fileInput,
      list,
      el("div", { class: "buttons" }, [
        el("button", { text: "← Back", onclick: () => { step = 2; renderStep(); } }),
        nextBtn,
      ]),
    ]);
  }

  async function stepInstruction() {
    const instructionArea = el("textarea", {
      style: "min-height:120px;",
      placeholder: 'Optional: "Draft the document based on the uploaded sources, focusing on FAST and MEPS+ rails." Leave blank to start from an empty document.',
    });
    const finishBtn = el("button", { class: "primary", text: "Skip → Open Document" });
    instructionArea.addEventListener("input", () => {
      finishBtn.textContent = instructionArea.value.trim() ? "Start Drafting →" : "Skip → Open Document";
    });
    finishBtn.addEventListener("click", () => {
      const instruction = instructionArea.value.trim();
      if (instruction) {
        sessionStorage.setItem(
          `docstudio:pendingInstruction:${slug}`,
          JSON.stringify({ instruction, checkedSourceIds: uploadedSources.map((s) => s.id) })
        );
      }
      closeModal();
      location.hash = `#/doc/${encodeURIComponent(slug)}`;
    });
    return el("div", {}, [
      wizardProgress(4),
      el("div", { class: "field" }, [el("label", { text: "Initial instruction (optional)" }), instructionArea]),
      el("div", {
        class: "empty-hint",
        text: "This is sent as the first instruction once the document opens — the same as typing it into the Conversation panel yourself. It kicks off an agentic draft using whatever sources you uploaded.",
      }),
      el("div", { class: "buttons" }, [
        el("button", { text: "← Back", onclick: () => { step = 3; renderStep(); } }),
        finishBtn,
      ]),
    ]);
  }

  renderStep();
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

async function openTemplateMarkdownEditor(docType, onSaved) {
  const { raw } = await api.getDocTypeRaw(docType);
  const textarea = el("textarea", { class: "tpl-raw-editor", text: raw, spellcheck: "false" });
  const errorBox = el("div", { class: "empty-hint tpl-raw-error", style: "display:none; color: var(--danger);" });
  const saveBtn = el("button", {
    class: "primary",
    text: "Save Template",
    onclick: async () => {
      saveBtn.disabled = true;
      errorBox.style.display = "none";
      try {
        await api.saveDocTypeRaw(docType, textarea.value);
        toast("Template saved");
        closeModal();
        if (onSaved) await onSaved();
      } catch (e) {
        errorBox.textContent = e.message;
        errorBox.style.display = "block";
      } finally {
        saveBtn.disabled = false;
      }
    },
  });
  const content = el("div", {}, [
    el("h3", { text: `Edit Template as Markdown — ${docType}` }),
    el("div", {
      class: "empty-hint",
      text: "Frontmatter (doc_type/name/version/word_template), then # General Instructions, # Chapters, # Clarification Policy, # Interview Bank, and # Quality Checklist sections — all in one file. This is exactly what's stored on disk, so you can generate it with an LLM and paste it straight in.",
    }),
    textarea,
    errorBox,
    el("div", { class: "buttons" }, [el("button", { text: "Cancel", onclick: closeModal }), saveBtn]),
  ]);
  openModal(content, { wide: true });
}

const NEW_TEMPLATE_SKELETON = (docType, name) => `---
doc_type: ${docType}
name: ${name}
version: '1.0'
---

# General Instructions

What this document is, who reads it, why it exists — plus document-wide conventions (tone, voice, formatting rules). Shared context for every chapter.

# Chapters

## 01 - Introduction
required: true
prompt: 'What this chapter must cover.'

# Clarification Policy

Guidance for when/how to ask clarifying questions, e.g. "only ask if the answer isn't inferable from sources and would materially change the chapter; prefer multiple-choice when the answer space is finite; up to 3 questions per chapter."

# Interview Bank


# Quality Checklist

`;

function openNewTemplateModal(onCreated) {
  const idInput = el("input", { type: "text", placeholder: "e.g. risk-assessment" });
  const nameInput = el("input", { type: "text", placeholder: "e.g. Risk Assessment Report" });
  const createBtn = el("button", {
    class: "primary",
    text: "Create →",
    onclick: async () => {
      const docType = idInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const name = nameInput.value.trim();
      if (!docType || !name) {
        toast("Both fields are required", true);
        return;
      }
      createBtn.disabled = true;
      try {
        await api.createDocType(docType, NEW_TEMPLATE_SKELETON(docType, name));
        closeModal();
        toast("Template created");
        if (onCreated) await onCreated();
        openTemplateMarkdownEditor(docType, onCreated);
      } catch (e) {
        toast(e.message, true);
        createBtn.disabled = false;
      }
    },
  });
  const content = el("div", {}, [
    el("h3", { text: "New Template" }),
    el("div", { class: "field" }, [el("label", { text: "Template ID (lowercase, hyphens)" }), idInput]),
    el("div", { class: "field" }, [el("label", { text: "Display Name" }), nameInput]),
    el("div", {
      class: "empty-hint",
      text: "Creates a minimal starting template with one chapter — opens the markdown editor next so you can flesh it out (or paste in something LLM-generated).",
    }),
    el("div", { class: "buttons" }, [el("button", { text: "Cancel", onclick: closeModal }), createBtn]),
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
  const generalInstructionsTa = el("textarea", {
    text: tpl.general_instructions || "",
    placeholder: "What this document is, who reads it, why it exists — plus document-wide conventions (tone, formatting rules). Shared context for every chapter.",
    style: "min-height:90px;",
  });
  const clarificationPolicyTa = el("textarea", {
    text: tpl.clarification_policy || "",
    placeholder: "Guidance for when/how the engine should ask clarifying questions, e.g. \"only ask if the answer isn't inferable from sources and would materially change the chapter; prefer multiple-choice; up to 3 questions per chapter.\"",
    style: "min-height:70px;",
  });

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
    el("div", { class: "tpl-section" }, [el("h4", { text: "General Instructions" }), generalInstructionsTa]),
    el("div", { class: "tpl-section" }, [el("h4", { text: "Chapters" }), chaptersHost, addChapterBtn]),
    el("div", { class: "tpl-section" }, [el("h4", { text: "Clarification Policy" }), clarificationPolicyTa]),
    el("div", { class: "tpl-section" }, [el("h4", { text: "Interview Bank (seed/example questions)" }), iqHost, addIQBtn]),
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
              general_instructions: generalInstructionsTa.value.trim(),
              clarification_policy: clarificationPolicyTa.value.trim(),
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
