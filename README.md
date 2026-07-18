# Document Studio (Prototype)

A standalone "NotebookLM for consulting deliverables" utility. Consultants
upload rough source material, an AI reasoning engine drafts structured
documents chapter-by-chapter as markdown, the consultant iterates per
chapter, and the result exports to a corporate Word template and/or
publishes as flat markdown into an ANTiRAG knowledge base.

This is a prototype: the AI reasoning engine is mocked behind a clean
interface (see below). The Word formatter started the same way but is now a
real, working implementation — it templates the actual `.docx` attached to
each document type rather than producing a stub. Everything else — UI, API,
file/folder management, versioning, ingestion, the drafting state machine —
is real.

## Running it

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Then open the printed URL (default `http://127.0.0.1:8077` — chosen to
avoid colliding with other local dev servers commonly bound to 8000/8080;
change `port` in `config.yaml` if 8077 is taken on your machine). No
internet access is required at runtime — `marked.js` and
`mermaid.js` are vendored locally under `docstudio/web/vendor/`.

On first run, `workspace/` is seeded automatically with the 3 doc-type
templates, a placeholder corporate Word template, and one example document
(a few drafted chapters, two ingested sources, one deferred open question,
two saved versions) so the app is immediately demonstrable.

## Architecture

```
app.py                  thin entrypoint (uvicorn.run)
docstudio/
  settings.py            app-level + workspace-level config loading
  models.py               pydantic models: manifest, chapters, doc-type
                           templates, ReasoningEngine request/event types
  engine/                 ReasoningEngine interface + MockReasoningEngine
  formatter/               DocFormatter interface + TemplatedDocFormatter
                            (real: fills {CHAPTERS}/{VARIABLE}s into the
                            attached .docx — see below)
  ingest/                  pdf/docx/xlsx/csv/txt -> markdown extraction
  store/                   filesystem-backed persistence
    documents.py             DocumentStore: doc.yaml + chapters CRUD
    templates.py             doc-type template parser + word template
                              registry + {VARIABLE} scanning
    versions.py              VersionStore: folder-snapshot versioning
    publisher.py             Publisher: copy-to-knowledge-base
    seed.py                  first-run seeding
  api/                     FastAPI routers (documents, sources, instruct,
                            versions, export, templates)
  web/                     static frontend (vanilla JS, ES modules, no
                            build step, no CDN dependencies)
```

`docstudio` is a plain importable Python package with no hard dependency on
ANTiRAG — the only integration points are filesystem paths
(`knowledge_base_path` in the workspace's `config.yaml`) and the `Publisher`
interface. This is intended to let the package later be vendored into and
launched from the ANTiRAG binary with `app.py` swapped for whatever
entrypoint ANTiRAG uses.

The frontend is plain HTML/CSS/JS (ES modules), served by FastAPI as static
files, so it runs fully offline in corporate environments. There is no
build step.

## The reasoning engine (mocked) and the Word formatter (real)

### ReasoningEngine (`docstudio/engine/__init__.py`)

```python
class ReasoningEngine(Protocol):
    async def run(self, request: EngineRequest, context: EngineContext) -> AsyncIterator[EngineEvent]: ...
```

`MockReasoningEngine` (`docstudio/engine/mock.py`) simulates a real
reasoning engine: it streams domain-flavored (banking/payments) markdown
chunk-by-chunk with realistic delays, generates outlines from the doc-type
template, iterates chapters based on free-text instructions, refreshes the
derived glossary chapter by scanning the other chapters for capitalized
terms/acronyms, and — once per document draft — pauses with a `Clarification`
event pulled from the doc-type template's interview bank. The instruct API
(`docstudio/api/instruct.py`) persists `ChapterComplete`/`ManifestUpdate`
events to disk as they stream past; a paused clarification simply ends the
SSE response, and the frontend resumes by calling `/clarify` and then
re-sending the same instruction.

**To replace with a real `CodexEngine`:** implement `ReasoningEngine.run`
as an async generator that shells out to the Codex CLI and translates its
streamed stdout into `ChapterDelta` / `ChapterComplete` / `Clarification` /
`ManifestUpdate` / `Log` / `Done` events (see `docstudio/models.py`), then
swap `MockReasoningEngine()` for `CodexEngine()` in
`docstudio/api/__init__.py::AppState.__init__`. Nothing in the API routers
or the frontend needs to change — they only ever see `EngineEvent` objects.

### DocFormatter (`docstudio/formatter/__init__.py`)

```python
class DocFormatter(Protocol):
    def build(self, document_dir: Path, word_template: Path, options: BuildOptions) -> Path: ...
```

Unlike the reasoning engine, this is a **real, working implementation** —
`TemplatedDocFormatter` (`docstudio/formatter/templated.py`) — built against
a convention found on an actual corporate FSD template supplied for this
project:

- A body paragraph containing exactly `{CHAPTERS}` marks where drafted
  chapter content is inserted, converted from markdown (headings, bullets,
  blockquotes, tables) into native docx elements styled with the
  template's *own* named styles (`Heading 1`-`9`, `Normal`, and whatever
  table style is demonstrated in the block below) — so generated content
  looks native to the template, not bolted on.
- `{VARIABLE}` tokens (ALL_CAPS convention — `{DOCUMENT_NAME}`,
  `{PROJECT_ID}`, etc.) anywhere in the document — body, tables, nested
  tables, headers, footers — are filled in from `DocManifest.variables`.
  Tokens can be split across multiple XML runs in the source `.docx` (a
  real Word artifact, not a hypothetical); substitution handles that by
  rewriting the paragraph's runs, not just searching each run in isolation.
  `CREATION_ON` and `DOC_NAME` are computed automatically (creation date,
  export filename) rather than asked of the user — see
  `SYSTEM_VARIABLES` in `templated.py` (mirrored in the frontend as
  `SYSTEM_TEMPLATE_VARIABLES` in `docstudio/web/js/util.js`). A lowercase
  `{yyyy}` token, if present, is always replaced with the current year.
- An optional `##STYLES_START##` / `##STYLES_END##` block — a
  style-reference cheat sheet for whoever built the template, demonstrating
  which named heading/table styles to use — is stripped from the delivered
  document if present.
- Sets Word's "update fields on open" flag so a stale Table of Contents
  recalculates page numbers the moment the file is opened (this prototype
  has no layout engine to compute real page numbers itself).

`docstudio/store/templates.py::scan_template_variables` scans a `.docx` for
distinct `{VARIABLE}` tokens (excluding `{CHAPTERS}`) — this powers both the
New Document wizard's variables step and the document view's **Variables**
button, both of which build a fill-in-the-blanks form from whatever the
attached template actually contains, live, not a hardcoded list. The seeded
`corporate-default.docx` is deliberately a minimal *working* example of
this convention (not just descriptive text) so a fresh clone demonstrates
the real mechanism without needing a real corporate template attached.

Validation (chapters not `final`, open questions > 0, unfilled template
variables) happens in `docstudio/api/export.py` before `build()` is
called, which offers an "export as DRAFT" path with the watermark flag.

**Known gaps:** no Mermaid-to-image rendering, no `embed`-mode source
tables yet, and only the first `{CHAPTERS}` match / first `##STYLES##`
block are handled (multiple templates with different structure would need
generalizing this). Swapping in a different implementation entirely: same
pattern as the engine — implement `DocFormatter.build` and register it in
`AppState` in place of `TemplatedDocFormatter`.

## Filesystem contract

There is no database — the filesystem is the source of truth. A single
configurable **workspace root** (default `./workspace`, see
`config.yaml` / `$DOCSTUDIO_WORKSPACE_ROOT`) holds:

```
workspace/
  documents/<slug>/
    doc.yaml              manifest: title, doc_type, status, chapters,
                           sources, builds, published
    chapters/*.md          one file per chapter, YAML frontmatter + body
    _sources/originals/     uploaded files as-is
    _sources/extracted/     auto-extracted markdown per source
    assets/                 images referenced by chapters
    decisions.md            append-only answered-clarification log
    versions/vN/             folder snapshots (chapters/, doc.yaml, decisions.md)
  templates/doc_types/*.md   master markdown templates (see below)
  templates/word_templates/*.docx
  exports/                   generated .docx builds
  config.yaml                 workspace-level config (knowledge_base_path, ...)
```

Doc-type templates (`templates/doc_types/*.md`) mix YAML frontmatter with a
custom-but-simple markdown structure: a `# Chapters` section where each `##
NN - Title` heading is followed by a small YAML block (`required`,
`derived`, `prompt`), a `# Interview Bank` section (a YAML list of
clarification questions keyed by chapter number, each with an optional
`context` pretext explaining *why* it's being asked), and a `# Quality
Checklist` section (a YAML list of strings). The frontmatter also carries a
`word_template` field — the `.docx` in `templates/word_templates/` used at
export time for documents of that type, so picking a document type at
creation is enough; no separate template choice is needed. See
`docstudio/store/templates.py` for the parser (every scalar round-trips
through `yaml.safe_dump`, so the format survives arbitrary edited text —
quotes, colons, newlines) and the three shipped templates (`fsd`,
`integration-spec`, `approach-doc`) for real examples. All of this — chapters,
prompts, interview bank, checklist, and the attached word template — is
editable from the **Templates** tab on the home screen, not just by hand-editing
the markdown file.

Versioning (`docstudio/store/versions.py`) is local folder-snapshot based,
behind a `VersionStore` protocol so a Git-backed implementation can replace
it later without touching the API. Restoring a version always auto-saves
the current state as a new version first — it's never destructive.

## ANTiRAG integration

Publishing (`docstudio/store/publisher.py`) is a `Publisher` protocol; the
prototype's `FilesystemPublisher` copies the current chapter markdowns
(with frontmatter), `doc.yaml`, and any chapter-referenced assets into
`<knowledge_base_path>/<knowledge_base_subpath>/<document-slug>/`,
overwriting whatever was published before — the knowledge base always holds
only the latest version, flat and searchable, with no version folders.
`knowledge_base_path` and `knowledge_base_subpath` are configured in the
workspace's `config.yaml` (seeded with sensible defaults on first run).

A later ANTiRAG integration swaps `FilesystemPublisher` for an
implementation that calls the ANTiRAG API or performs a git-commit
one-liner — the `Publisher.publish(documents, slug) -> PublishResult`
signature stays the same, so nothing else in the app needs to change.

## UI layout

Inside a document, the left pane is tabbed (**Sources** / **Chapters**) and
collapsible; the **Chapters** tab is the drafting-order source of truth — it
supports drag-to-reorder, delete, and adding a chapter manually (title only;
content comes from an instruction afterwards). Clicking a chapter there
*focuses* the middle pane on just that chapter (click again, or "Show all
chapters", to go back to the full document). The right pane holds the single
Conversation/instruction box, also collapsible — its scope selector follows
whichever chapter is focused, so **Iterate** on a chapter card just focuses
it and lets you type into the right pane rather than opening an inline box
per chapter. **Interview me** there triggers the engine's interview-bank walk
explicitly, independent of drafting.

## API

See `docstudio/api/*.py`; routes closely follow the sketch in
`requirements.md` §11, plus additions the UI needed that weren't in the
original sketch: `PATCH`/`DELETE /api/documents/{slug}` (editable
title/status/variables, permanent delete-from-disk with a confirm step in
the UI), `PATCH .../sources/{id}` (label/mode edits), `POST`/`DELETE`/`POST
.../reorder` on `.../chapters` (add/delete/reorder), and `GET`/`PUT
/api/templates/doc_types/{doc_type}` + `POST .../word_template` for the
template editor (the `GET` also returns a live-scanned `template_variables`
list, per the DocFormatter section above).

## Known prototype limitations

- Single-user, no auth, no concurrency control — the filesystem is written
  directly on each request.
- Chat/conversation history is intentionally ephemeral (kept in the
  browser only), per the spec — `decisions.md` and the chapter files are
  the persistent record of what was decided.
- The mock engine's "domain knowledge" is a phrase bank, not real
  reasoning — content is plausible-looking, not accurate.
