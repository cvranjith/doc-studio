# Document Studio (Prototype)

A standalone "NotebookLM for consulting deliverables" utility. Consultants
upload rough source material, an AI reasoning engine drafts structured
documents chapter-by-chapter as markdown, the consultant iterates per
chapter, and the result exports to a corporate Word template and/or
publishes as flat markdown into an ANTiRAG knowledge base.

This is a prototype: the AI reasoning engine and the Word formatter are
mocked behind clean interfaces (see below). Everything else — UI, API,
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
  formatter/               DocFormatter interface + MockDocFormatter
  ingest/                  pdf/docx/xlsx/csv/txt -> markdown extraction
  store/                   filesystem-backed persistence
    documents.py             DocumentStore: doc.yaml + chapters CRUD
    templates.py             doc-type template parser + word template registry
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

## The two mock interfaces

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

`MockDocFormatter` (`docstudio/formatter/mock.py`) produces a plausible
stub `.docx` via `python-docx`: a title page (with a DRAFT watermark
paragraph when `options.force_draft_watermark` is set) followed by each
chapter's raw markdown converted to headings/bullets/paragraphs. Validation
(chapters not `final`, open questions > 0) happens in
`docstudio/api/export.py` before `build()` is called, which offers an
"export as DRAFT" path with the watermark flag.

**To replace with a real formatter:** implement `DocFormatter.build` to
concatenate chapters in manifest order, render Mermaid blocks to images,
embed `assets/` images, render `embed`-mode sources as tables, and inject
into the corporate template's named placeholders — then swap
`MockDocFormatter()` for the real implementation in `AppState`.

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
original sketch: `PATCH /api/documents/{slug}` (editable title/status),
`PATCH .../sources/{id}` (label/mode edits), `POST`/`DELETE`/`POST
.../reorder` on `.../chapters` (add/delete/reorder), and `GET`/`PUT
/api/templates/doc_types/{doc_type}` + `POST .../word_template` for the
template editor.

## Known prototype limitations

- Single-user, no auth, no concurrency control — the filesystem is written
  directly on each request.
- Chat/conversation history is intentionally ephemeral (kept in the
  browser only), per the spec — `decisions.md` and the chapter files are
  the persistent record of what was decided.
- The mock engine's "domain knowledge" is a phrase bank, not real
  reasoning — content is plausible-looking, not accurate.
