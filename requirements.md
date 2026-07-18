# Requirements: Document Studio (Prototype)

A standalone "NotebookLM for consulting deliverables" utility. Consultants provide rough source material, an AI reasoning engine drafts structured documents chapter-by-chapter as markdown, the consultant iterates per-chapter, and the final result is (a) exportable to a corporate Word template and (b) publishable as flat markdown files into an ANTiRAG knowledge base.

**This is a prototype.** The AI reasoning engine (Codex CLI) and the Word document formatter are OUT OF SCOPE — implement both behind clean interfaces with mock implementations. Everything else (UI, API, file/folder management, versioning, ingestion, state machine) should be real and working.

---

## 1. Architecture & Tech Stack

- **Backend:** Python 3.11+, FastAPI, uvicorn. No database — the filesystem IS the database. All state lives in folders and files so it remains portable, inspectable, and Git-friendly.
- **Frontend:** Single-page app. Plain HTML/JS/CSS or a lightweight framework, served by FastAPI as static files. Must work fully offline (no CDN dependencies at runtime — vendor any libraries locally). Corporate-environment friendly.
- **Packaging:** Design the business logic as an importable Python package (e.g., `docstudio/`) with a thin `app.py` entrypoint, so the module can later be bundled into and launched from the ANTiRAG binary. No hard dependencies on ANTiRAG code — integration points are file paths and a publish function.
- **Reasoning engine:** Abstract interface `ReasoningEngine` (see §7). Ship `MockReasoningEngine`. A future `CodexEngine` will shell out to Codex CLI — do not implement it, but design the interface so it can stream output.
- **Doc formatter:** Abstract interface `DocFormatter` (see §8). Ship `MockDocFormatter` that produces a plausible placeholder .docx or a stub file.

## 2. Workspace Layout (Filesystem Contract)

A single configurable **workspace root** (default `./workspace`, configurable via `config.yaml` or env var):

```
workspace/
  documents/
    <document-slug>/            # one folder per document
      doc.yaml                  # manifest (see §3)
      chapters/
        01-introduction.md
        02-scope.md
        ...
        90-glossary.md
      _sources/
        originals/              # uploaded files as-is (pdf, xlsx, docx, txt, images, md)
        extracted/              # auto-extracted text/markdown per source
      assets/                   # images referenced by chapters
      decisions.md              # answered clarification Q&A log (append-only)
      versions/                 # saved version snapshots (see §9)
        v1/
        v2/
  templates/
    doc_types/                  # master markdown templates per document type (see §4)
      fsd.md
      integration-spec.md
      approach-doc.md
    word_templates/             # corporate .docx templates with placeholders
      corporate-default.docx
  exports/                      # generated .docx builds
  config.yaml
```

## 3. Document Manifest (`doc.yaml`)

```yaml
title: "SMBC Payment Gateway FSD"
slug: "smbc-payment-gateway-fsd"
doc_type: "fsd"                     # references templates/doc_types/fsd.md
template_version: "1.0"
client: "SMBC"
author: ""
created: "2026-07-18T10:00:00"
updated: "2026-07-18T12:30:00"
status: "drafting"                  # drafting | review | final
current_version: 3                  # latest saved version number
chapters:
  - file: "01-introduction.md"
    title: "Introduction"
    status: "final"                 # empty | drafting | draft | reviewed | final
    derived: false
    open_questions: 0
  - file: "90-glossary.md"
    title: "Glossary"
    status: "draft"
    derived: true                   # derived chapters get "Refresh" instead of "Iterate"
    open_questions: 0
sources:
  - file: "originals/client-email-thread.pdf"
    extracted: "extracted/client-email-thread.md"
    label: "Client email thread"
    mode: "source"                  # source | embed (embed = render file as table at build)
builds:
  - version: 2
    word_template: "corporate-default.docx"
    exported: "2026-07-17T15:00:00"
    file: "exports/smbc-payment-gateway-fsd-v2.docx"
published:
  last_version: 2
  last_published: "2026-07-17T16:00:00"
```

Each chapter markdown file has YAML frontmatter:

```yaml
---
title: "Introduction"
status: "draft"
sources_used: ["client-email-thread.pdf"]
last_generated: "2026-07-18T11:00:00"
---
```

## 4. Document Type Templates (Master Markdown)

Each file in `templates/doc_types/` defines a document type. Structure:

```markdown
---
doc_type: fsd
name: "Functional Specification Document"
version: "1.0"
---

# Chapters

## 01 - Introduction
required: true
prompt: |
  This chapter must answer: what system, what business context, who are the stakeholders.
  Tone: formal, third person. Length: 300-500 words.

## 02 - Scope
required: true
prompt: |
  In-scope and out-of-scope as two lists. Must be unambiguous.

## 90 - Glossary
required: true
derived: true
prompt: |
  Extract all domain terms, acronyms, and system names used across all chapters.
  One table: Term | Definition.

# Interview Bank

- q: "What is the target go-live date?"
  chapter: "01"
  choices: []                       # empty = free text
- q: "Which payment rails are in scope?"
  chapter: "02"
  choices: ["FAST", "MEPS+", "SWIFT", "Multiple / other"]

# Quality Checklist

- "No chapter contradicts the scope chapter"
- "All acronyms appear in the glossary"
```

Parse these templates into a typed model. Ship the three example templates above with realistic content (fsd, integration-spec, approach-doc).

## 5. UI — Three-Pane Layout

**Header bar:** document title (editable), doc type badge, overall status, buttons: Save Version, Export to Word, Publish to Knowledge Base, History.

**Left pane — Sources:**
- Upload files (drag-drop + button). Accept: pdf, docx, xlsx, csv, md, txt, png, jpg.
- List sources with checkboxes = "in scope for the next instruction". Checked state is passed to the reasoning engine call.
- Per-source: label (editable), mode toggle (source / embed — embed only for xlsx/csv), delete, view extracted text in a modal.
- Ingestion (see §6) runs on upload; show extraction status per file.

**Middle pane — Conversation:**
- Chat-style stream: user instructions, engine responses, and **clarification cards** (see below).
- Input box with scope selector: "Document" (default) or a specific chapter (dropdown). Chapter-scoped instructions target one file only.
- Clarification cards: rendered from structured question objects emitted by the engine — question text, reason ("blocking Chapter 03"), choice chips (if provided) + free-text field, and a **Defer** button. Answered → appended to `decisions.md` and sent back to the engine. Deferred → engine proceeds and inserts `> [OPEN QUESTION: ...]` blockquote markers in the chapter; open-question counts update in manifest and UI badges.
- Chat history is ephemeral per session (keep in memory / sessionStorage). It is NOT persisted to the document folder — decisions and content are the persistent artifacts.

**Right pane — Document:**
- Chapter list from manifest order. Each chapter card: title, status pill, open-question badge, and rendered markdown (client-side markdown rendering; render Mermaid code blocks with mermaid.js vendored locally).
- Per-chapter actions: **Iterate** (inline instruction box → chapter-scoped engine call), **Edit** (raw markdown editor with side-by-side preview, save writes the file), **Regenerate**, **Mark reviewed / Mark final**. Derived chapters (glossary): **Refresh** instead of Iterate.
- Streaming: while the engine drafts, stream content into the chapter card token-by-token / chunk-by-chunk (SSE or WebSocket). The mock engine must simulate streaming with realistic delays so the UX is demonstrable.

**Home / browser view:** grid or list of all documents in `workspace/documents/` showing manifest metadata (title, type, client, status, updated, open questions). New Document flow: pick doc type → title/client → creates folder + manifest + empty chapter stubs from template. Also a Templates view: list doc-type templates and word templates, upload new word template.

## 6. Source Ingestion

On upload to `_sources/originals/`, run extraction into `_sources/extracted/` as markdown:
- **pdf** → text extraction (pypdf/pdfplumber acceptable for prototype)
- **docx** → text (python-docx or mammoth)
- **xlsx/csv** → one markdown table per sheet (cap rows, note truncation)
- **md/txt** → copy through
- **images** → no extraction; stored and referenceable from chapters

Extraction failures must not block upload — mark status "extraction failed", still usable as label-only.

## 7. ReasoningEngine Interface (MOCK)

```python
class ReasoningEngine(Protocol):
    async def run(self, request: EngineRequest) -> AsyncIterator[EngineEvent]: ...
```

`EngineRequest` contains: instruction text, scope (document | chapter id), document manifest, doc-type template, checked source extracts, glossary, prior chapter contents as needed. `EngineEvent` is a union: `ChapterDelta(chapter, text_chunk)`, `ChapterComplete(chapter, full_markdown)`, `Clarification(question, reason, choices, blocking_chapter)`, `ManifestUpdate(...)`, `Log(message)`, `Done`.

`MockReasoningEngine` behavior (make the demo feel real):
- "Generate outline" style instructions → emit chapter stubs per template.
- Document-scoped draft → stream plausible lorem-flavored but domain-looking content (banking/payments phrasing) into each empty chapter sequentially, occasionally emitting a `Clarification` event (sometimes with choices) before continuing.
- Chapter-scoped iterate → stream a modified version of that chapter.
- Glossary refresh → scan chapter files for capitalized terms/acronyms, emit a glossary table.
- Include one deliberately deferred-question demo path: if a clarification is deferred, insert an `[OPEN QUESTION: ...]` marker into the chapter.

Document the interface clearly so a `CodexEngine` (subprocess to Codex CLI, streaming stdout) can be dropped in later without touching the UI or API.

## 8. DocFormatter Interface (MOCK)

```python
class DocFormatter(Protocol):
    def build(self, document_dir: Path, word_template: Path, options: BuildOptions) -> Path: ...
```

Real implementation will: concatenate chapters in manifest order, render Mermaid to images, embed `assets/` images, render embed-mode sources as tables, inject into corporate template placeholders. **Mock:** validate (warn if chapters not final / open questions > 0, offer "export as DRAFT" with watermark flag in BuildOptions), then produce a stub .docx (python-docx with title page + raw chapter text is fine) into `exports/`, and record the build in the manifest. Wire the full validate → pick template → build → download flow in the UI.

## 9. Versioning (Local, Folder-Snapshot Based)

Explicit user-driven versions, no Git dependency in the prototype:
- **Save Version** button: copies `chapters/`, `doc.yaml`, `decisions.md` into `versions/vN/` (increment N), updates `current_version`. Sources and assets are NOT copied (they're append-mostly; reference them).
- **History view:** list versions with timestamps; per version: view chapters read-only, per-chapter diff vs current (server-side unified diff, rendered nicely), and **Restore** (restoring first auto-saves current state as a new version, then copies vN back — never destructive).
- Keep the versioning behind a small `VersionStore` interface so a Git-backed implementation can replace folder snapshots later.

## 10. Publish to ANTiRAG Knowledge Base

- Config key `knowledge_base_path` in `config.yaml` (a local folder path for the prototype).
- **Publish** button: copies the *current* chapter markdowns (frontmatter included) + `doc.yaml` + referenced assets into `<knowledge_base_path>/<configurable-subpath>/<document-slug>/`, overwriting previous publish — the knowledge base always holds only the latest version, flat and searchable. No version folders are published.
- Record `published.last_version` / timestamp in the manifest. Show publish status in UI.
- Implement as a small `Publisher` interface (prototype: filesystem copy; later: ANTiRAG API / git commit one-liner).

## 11. API Sketch (adjust as sensible)

```
GET    /api/documents                      list
POST   /api/documents                      create from doc type
GET    /api/documents/{slug}               manifest + chapter list
GET    /api/documents/{slug}/chapters/{f}  raw markdown
PUT    /api/documents/{slug}/chapters/{f}  save edit
POST   /api/documents/{slug}/sources       upload (multipart) → ingest
DELETE /api/documents/{slug}/sources/{id}
POST   /api/documents/{slug}/instruct      body: instruction, scope, checked sources → SSE/WS stream of EngineEvents
POST   /api/documents/{slug}/clarify       answer or defer a clarification
POST   /api/documents/{slug}/versions      save version
GET    /api/documents/{slug}/versions      list; GET .../{n}/diff/{chapter}
POST   /api/documents/{slug}/restore/{n}
POST   /api/documents/{slug}/export        build docx → returns file path/download
POST   /api/documents/{slug}/publish
GET    /api/templates/doc_types            ; GET /api/templates/word ; POST /api/templates/word
```

## 12. Non-Functional / Prototype Notes

- Everything must run with `pip install -r requirements.txt` + one command (`python app.py` or `uvicorn ...`). No external services, no internet at runtime.
- Seed the workspace on first run: the 3 doc-type templates, 1 placeholder word template, and 1 example document with a few drafted chapters, a couple of sources, one open question, and 2 saved versions — so the demo works immediately.
- Clean separation: `docstudio/engine/`, `docstudio/formatter/`, `docstudio/store/` (documents, versions, publisher), `docstudio/ingest/`, `docstudio/api/`, `docstudio/web/` (static frontend).
- Write a concise README covering: architecture, the two mock interfaces and how to replace them (CodexEngine, real DocFormatter), the filesystem contract, and how ANTiRAG integration works.
- Code quality over feature count: if trimming is needed, keep the full loop working end-to-end (create → upload source → instruct → stream draft → clarify → iterate a chapter → edit → save version → export mock docx → publish).
