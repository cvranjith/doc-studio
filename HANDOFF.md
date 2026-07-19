# Handoff: wiring a real ReasoningEngine

This document is for whoever picks up this project next to replace the
mocked AI reasoning engine with a real one (Claude, or any other model).
Everything else in the app — UI, API, filesystem persistence, ingestion,
versioning, Word export, publishing, template editing — is real and working
today, not a stub. The **only** thing standing between this and a working
AI-assisted document drafting tool is `MockReasoningEngine`.

Read this top to bottom before touching code — sections 1-3 are the actual
task; sections 4-6 are the "everything else already built" reference you'll
need while doing it; section 7 is what to verify when you're done.

For a general project overview (architecture diagram, running instructions,
known limitations) see `README.md`. This document goes deeper specifically
on the engine boundary.

---

## 1. What "done" looks like

Replace `MockReasoningEngine` (`docstudio/engine/mock.py`) with a real
implementation of the same `ReasoningEngine` Protocol, register it in
`AppState`, and nothing else in the app should need to change — the API
routers and the entire frontend only ever see `EngineEvent` objects, never
engine-specific detail. That boundary is the whole point of this
architecture; if you find yourself needing to touch `docstudio/api/*.py` or
`docstudio/web/js/*.js` to make the real engine work, something's off and
worth flagging rather than working around.

The one-line swap point is `docstudio/api/__init__.py`:

```python
class AppState:
    def __init__(self, settings: Settings):
        ...
        self.engine = MockReasoningEngine()   # <-- replace this
```

## 2. The contract you're implementing

`docstudio/engine/__init__.py`:

```python
class ReasoningEngine(Protocol):
    async def run(self, request: EngineRequest, context: EngineContext) -> AsyncIterator[EngineEvent]:
        """Yield EngineEvents as the instruction is carried out. Must
        eventually yield a DoneEvent. Implementations should be safe to
        cancel mid-stream (e.g. client disconnect)."""
```

### `EngineRequest` (what the UI sent)

```python
class EngineRequest(BaseModel):
    instruction: str                              # free text, e.g. "Draft the document"
    scope: str = "document"                        # "document" | a specific chapter file, e.g. "02-scope.md"
    checked_source_ids: list[str] = []              # which uploaded sources the user has checked on
    session_answers: dict[str, str] = {}            # DEAD FIELD — see §5, ignore it
```

### `EngineContext` (assembled by `docstudio/api/instruct.py::_build_context` before every call — you don't build this, you consume it)

```python
@dataclass
class EngineContext:
    manifest: DocManifest                    # the document's full doc.yaml, incl. chapter list/status
    doc_type_template: DocTypeTemplate        # the doc-type's full template — see §4, this is your prompt material
    checked_source_extracts: dict[str, str]   # source id -> full extracted markdown text (only for checked_source_ids)
    glossary_chapter: str | None              # file name of the derived glossary chapter, if any
    prior_chapter_bodies: dict[str, str]      # file -> current markdown body, for every chapter (for cross-chapter consistency)
    decisions_text: str = ""                  # the full contents of decisions.md — every answered/deferred clarification so far
```

Notes on using this:
- `checked_source_extracts` is already-extracted plain markdown (pdf/docx/xlsx/csv/txt all get converted to markdown on upload — see `docstudio/ingest/`). You get full text, not chunks — there's no retrieval/ranking layer. At the scale of a handful of uploaded consulting-engagement documents this is fine to stuff directly into context; only worth revisiting if someone uploads something huge.
- `prior_chapter_bodies` includes chapters that haven't been drafted yet too (they'll just be the `"> _Not yet drafted._"` placeholder) — filter by `context.manifest.chapters[i].status` if you only want drafted ones.
- `decisions_text` is literally the rendered contents of `workspace/documents/<slug>/decisions.md` — a human-readable **and** engine-readable append-only log (see `DocumentStore.append_decision`). Every `Q:`/`A:` pair the consultant has ever answered is in there in full, so a real engine should read it (not re-derive answers already given) rather than needing separate structured state.

### `EngineEvent` (what you yield)

```python
EngineEvent = Union[ChapterDelta, ChapterComplete, Clarification, ManifestUpdate, LogEvent, DoneEvent]
```

| Event | Fields | What it does |
|---|---|---|
| `ChapterDelta` | `chapter`, `text_chunk` | Appended live to the chapter card in the UI as it streams. Cosmetic only — not persisted. Chunk size/pacing is up to you; the UI shows a pulsing "Writing…" badge while these are arriving. |
| `ChapterComplete` | `chapter`, `full_markdown` | **Persisted.** `instruct.py` writes this verbatim to `chapters/<file>.md` (frontmatter preserved, body replaced) the moment it's received. This is the actual chapter content — deltas are purely a streaming visual, the complete event is the source of truth. |
| `Clarification` | `question_id`, `question`, `reason`, `choices`, `blocking_chapter` | Pauses the stream. The SSE response ends right after this (see §3). `reason` is shown to the consultant as *why* you're asking — this is where a real engine's actual justification goes, not boilerplate. `choices` empty = free-text answer; non-empty = the UI renders clickable chips. |
| `ManifestUpdate` | `chapter`, `status`, `open_questions` | Persisted status transitions (`empty→drafting→draft→reviewed→final`). Usually paired right after a `ChapterComplete`. |
| `LogEvent` | `message` | Shown in the conversation pane as a system note. Not persisted. Use it for narration ("Paused for clarification…", "Draft complete for all pending chapters."). |
| `DoneEvent` | — | **Must always be the last event yielded**, even after an early return for a clarification pause. The SSE stream closes on this. |

### The pause/resume mechanism (important, non-obvious)

There's no session state, no in-memory "waiting for an answer" flag. The
whole mechanism is: yield a `Clarification`, then stop (yield `DoneEvent`
and return) — same as ending the document draft early. The frontend shows
the question, the consultant answers or defers via `POST
/documents/{slug}/clarify` (`docstudio/api/instruct.py`), which appends a
`**Q:** ...\n\n**A:** ...` block to `decisions.md` (or a `[OPEN QUESTION:
...]` marker into the chapter body, if deferred) — then the frontend just
re-sends the *original* instruction to `/instruct` again. Your engine gets
called fresh, with `decisions_text` now containing the answer. This means:

- Your engine must be **idempotent/re-entrant per call** — every invocation
  starts from "given the current state of everything, what's the next
  thing to do," not "continue where I left off in memory." There is no
  "continue" concept; there's only "given current disk state, decide again."
- To know a question's already been answered, check whether it (or its
  effect) shows up in `decisions_text` — don't just track question IDs
  in-process, since the process may have restarted between the ask and the
  answer.
- Deferred questions leave a `[OPEN QUESTION: ...]` marker literally in the
  chapter body (visible to the reader, and counted in
  `ChapterRef.open_questions`) — check `prior_chapter_bodies` for that
  marker too, so you don't re-ask something already deferred.

`MockReasoningEngine._unresolved_question` / `_interview` in
`docstudio/engine/mock.py` show exactly this pattern today (substring
matching against `decisions_text` and the marker) — worth reading even
though the decision logic itself (table lookup) is what you're replacing.

### Scope: document-level draft vs. one chapter

`request.scope` is either `"document"` (draft/continue drafting the whole
document, chapter by chapter) or a specific chapter file name (act on just
that one chapter — this is both "Iterate" with a free-text instruction, and
"Regenerate," and the derived-glossary "Refresh").

The orchestration loop for document-scope ("which chapter is next, keep
going until done or blocked") lives **inside the engine implementation**,
not in the API layer — see `MockReasoningEngine._draft_document` for the
existing pattern (iterate `context.manifest.chapters`, skip ones already
`draft`/`reviewed`/`final`, stop and return the moment one needs a
clarification). Keep that responsibility in your engine too; the API layer
is deliberately dumb about this.

Derived chapters (`ChapterSpec.derived=True`, e.g. Glossary) are handled
separately (`_refresh_derived` in the mock) — they're generated *from* the
other chapters' content rather than from source material + a prompt, and
never ask clarifying questions.

## 3. Recommended mechanism: per-chapter tool-use call

This isn't part of the frozen contract (the event/model shapes above are),
but it's the approach that was designed for this and maps cleanly onto it:

For each pending chapter, make **one streaming LLM call** with two tools
available: `write_chapter(markdown: str)` and
`ask_clarifying_questions(questions: [{question, reason, choices}])` (1-3
items), and let the model pick one. With Claude's streaming API you know
from the first `content_block_start` event which branch it took, so you can
translate live into the event union above — text deltas become
`ChapterDelta`/`ChapterComplete`, a tool call to `ask_clarifying_questions`
becomes one or more `Clarification` events. No separate "decide first, then
generate" round trip needed.

The assembled prompt for that call, per chapter, roughly:
- System: `doc_type_template.general_instructions` (what this document
  type is, who reads it, tone/conventions — shared across every chapter)
- This chapter's `ChapterSpec.title` + `.prompt`
- `context.decisions_text` (so it doesn't re-ask something already answered)
- `context.prior_chapter_bodies` (for cross-chapter consistency — e.g. Scope
  shouldn't contradict Introduction)
- `context.checked_source_extracts` (full text of whatever the consultant
  has checked on)
- `doc_type_template.clarification_policy` (when/how to ask — see §4) +
  `doc_type_template.quality_checklist` (self-check before calling
  `write_chapter` complete)

## 4. The template schema — your primary prompt material

Doc-type templates (`workspace/templates/doc_types/*.md`, one file per doc
type — `fsd`, `integration-spec`, `approach-doc` are seeded) are single
markdown files: YAML frontmatter + five `#`-prefixed sections. Parser/
renderer: `docstudio/store/templates.py::parse_doc_type_template` /
`render_doc_type_template`. Editable two ways in the UI (Templates tab):
a structured form, or the raw markdown directly (`Edit as Markdown` —
handy if you're generating templates with an LLM too and want to paste the
result straight in).

```
---
doc_type: fsd
name: Functional Specification Document
version: '1.0'
word_template: corporate-default.docx
---

# General Instructions
Free text. What this document type is, who reads it, why it exists, plus
document-wide conventions (tone, formatting rules — e.g. "every requirement
gets a unique ID"). This is your system-prompt preamble, shared across every
chapter call, so individual chapter prompts don't need to repeat it.

# Chapters
## 01 - Introduction
required: true
prompt: 'What this chapter must cover, length/tone guidance specific to it.'
## 90 - Glossary
required: true
derived: true
prompt: '...'

# Clarification Policy
Free text. Guidance for *when* and *how* your engine should ask questions —
e.g. "only ask if the answer isn't inferable from sources and would
materially change the chapter; prefer multiple-choice when the answer space
is finite; batch up to 3 questions per chapter." This is the field the
whole clarification design in §2-3 is built around — read it, follow it.

# Interview Bank
A YAML list of example/seed questions (q, chapter, choices, context). Two
roles: (a) the *only* thing `MockReasoningEngine` uses — it's a fixed
script for the deterministic demo, not real reasoning; (b) for a real
engine, treat these as illustrative few-shot examples of what kinds of
things get asked for this doc type — not an exhaustive or authoritative
list. Your engine should generate its own questions dynamically per
Clarification Policy, using this bank as inspiration/priming, not lookup.

# Quality Checklist
A YAML list of strings — a final self-check rubric ("No chapter contradicts
the scope chapter", "All acronyms appear in the glossary"). Feed this into
the chapter-writing prompt as things to satisfy before calling a chapter
done.
```

All three seeded templates (`workspace/templates/doc_types/{fsd,
integration-spec, approach-doc}.md`, generated from
`docstudio/store/seed.py`) have real, non-empty content in every section
already — read them for a sense of the intended tone/detail level, not just
the schema shape.

## 5. Approved contract changes not yet implemented

These were designed and agreed on but deliberately left for whoever wires
the real engine, since they only matter once there's a real engine to
exercise them:

1. **Drop `EngineRequest.session_answers`.** It's currently unused —
   `MockReasoningEngine` reads `decisions_text` instead (see §2). Just
   delete the field from `docstudio/models.py`; nothing references it.

2. **Batch `Clarification` with progress info.** Add two optional fields:
   ```python
   class Clarification(BaseModel):
       ...
       batch_id: str | None = None       # ties questions from the same reasoning pass together
       batch_position: str | None = None # e.g. "2/3", for display only
   ```
   When your per-chapter call asks 2-3 questions at once (via
   `ask_clarifying_questions`, §3), yield them as 2-3 consecutive
   `Clarification` events sharing one `batch_id` — don't call the LLM again
   between them, they came from one reasoning pass. The existing
   single-question card UI (`buildClarificationForm` in
   `conversation.js`) needs no changes to keep working; `batch_position` is
   available if you want to wire in a "Question 2 of 3" label later, but
   isn't required for correctness.

3. **Chapter-scoped iterate can also clarify.** No schema change — `
   Clarification.blocking_chapter` already works for any scope. It's purely
   that `MockReasoningEngine._iterate_chapter` never emits one; your
   engine's chapter-call should be able to, uniformly, whether it's
   document-scope drafting or a one-off "make this more formal" iterate.

## 6. Everything else already built (context, not your task)

Skim this so you know what's already handled and don't accidentally
duplicate or fight it.

**Documents & chapters** — `docstudio/store/documents.py`
`DocumentStore`. Filesystem-as-database, no DB: `workspace/documents/<slug>/`
holds `doc.yaml` (manifest), `chapters/*.md` (YAML frontmatter + markdown
body per file), `_sources/{originals,extracted}/`, `assets/` (images),
`decisions.md`, `versions/vN/`. A chapter's title is kept in sync with its
body's leading `# Heading` line automatically on every save
(`save_chapter` → `extract_h1_title`) — so renaming a chapter is just
editing the heading, whether that edit came from the WYSIWYG editor, a
manual markdown edit, or your engine's `ChapterComplete`. New chapters
added manually append to the end of the list (`add_chapter`, `position=None`
→ `len(chapters)`).

**Ingestion** — `docstudio/ingest/` (pdf, docx, spreadsheet, text — csv/md/txt/image
dispatch by extension). Every upload gets auto-extracted to markdown into
`_sources/extracted/`; extraction status (`pending/ok/failed/unsupported`)
is tracked per source. Sources have a `mode` (`source` vs `embed` — the
formatter/engine can treat these differently later; currently both just
mean "included if checked"). This is what populates
`context.checked_source_extracts`.

**Templates (doc-type)** — `docstudio/store/templates.py` /
`docstudio/api/templates.py`. Full CRUD: structured form editor, raw
markdown editor (`GET`/`PUT .../raw`), create new (`POST`, validates
frontmatter + non-empty `name` before saving), delete. A `.docx` word
template attaches to each doc type; `scan_template_variables` live-scans it
for `{VARIABLE}` tokens (body, tables, nested tables, headers, footers) to
build the fill-in-the-blanks form in the New Document wizard and the
document view's Variables modal.

**Word export** — `docstudio/formatter/templated.py`
`TemplatedDocFormatter` — real, not a stub. Fills `{CHAPTERS}` by
converting each chapter's markdown into native docx elements (headings,
bullets, blockquotes, tables, inline bold/italic/code via
`_apply_inline_markdown`) styled with the template's own named styles, and
inline-embeds images referenced via `assets/<file>` paths (works even
mid-line, not just on their own line). Fills `{VARIABLE}` tokens from
`DocManifest.variables` (handles tokens split across multiple XML runs — a
real Word artifact quirk). `CREATION_ON`/`DOC_NAME` are computed
automatically (`SYSTEM_VARIABLES`); a bare `{yyyy}` is always replaced with
the current year. Strips an optional `##STYLES_START##`/`##STYLES_END##`
style-reference block if present. `docstudio/api/export.py` validates
first (non-final chapters, open questions, unfilled variables) and offers
an "export as draft" path with a watermark if the consultant confirms past
warnings.

**Versioning** — `docstudio/store/versions.py`, folder-snapshot based
behind a `VersionStore` protocol (swappable for git-backed later).
Restoring always auto-saves current state first — never destructive.
Per-chapter unified diff view in the UI.

**Publishing** — `docstudio/store/publisher.py` `FilesystemPublisher`,
behind a `Publisher` protocol. Copies current chapters + manifest + assets
to `<knowledge_base_path>/<subpath>/<slug>/`, flat, always overwritten (no
version history in the KB — that's what `versions/` is for). This is the
ANTiRAG integration point; swap the implementation, keep the
`publish(documents, slug) -> PublishResult` signature.

**Frontend** — vanilla JS ES modules, no build step, no CDN (everything
vendored under `docstudio/web/vendor/`: `marked.js`, `mermaid.js`,
`turndown.js`, Font Awesome). Three-pane document view (Sources/Chapters
tabs on the left, chapters in the middle, chat-style Conversation panel on
the right). WYSIWYG chapter editor (`docstudio/web/js/wysiwyg.js`) stores
markdown underneath (`marked.js` on load, `turndown.js` on save), with a
raw-source toggle for anything it can't round-trip (tables). Chapter cards
show a pulsing glow + animated "Writing…" badge while `ChapterDelta` events
are streaming in — this already works with the mock and needs nothing
different from a real engine, since it's driven purely by the same SSE
event stream.

## 7. Verifying your engine works

There's no test suite (prototype) — verification has been manual, driving
the actual browser through the golden path with Playwright. Suggested
checklist for your change specifically:

1. `python app.py`, open the seeded "Meridian Bank Payment Gateway FSD" doc.
2. Send "Draft the document" scoped to Document — chapters should stream in
   live, one at a time, respecting `general_instructions`/chapter `prompt`s
   from the `fsd` template.
3. Trigger a real clarification on a fresh `integration-spec` document (new
   doc, no sources uploaded, ask it to draft) — confirm the question/reason
   shown make sense for that specific gap, not a canned string; answer it
   via a chip or free text; confirm the stream resumes and the answer shows
   up reflected in the next chapter drafted, and in `decisions.md`.
4. Test a batch of 2-3 questions on one chapter, if you implement §5.2 —
   confirm they don't all fire a fresh LLM call each.
5. Iterate a single already-drafted chapter with an ambiguous instruction —
   confirm it can still pause with a `Clarification` (§5.3) rather than
   guessing.
6. Defer a question instead of answering — confirm `[OPEN QUESTION: ...]`
   lands in the chapter body and the chapter's open-question badge updates.
7. Refresh the derived Glossary chapter after drafting a few others —
   confirm it pulls real terms from `prior_chapter_bodies`, not the mock's
   regex-based term scraper.
8. Export to Word once a document is fully drafted+final — confirm the
   output still looks right (this exercises `TemplatedDocFormatter`, which
   you shouldn't need to touch, but it's the end of the pipeline your
   content flows through).

## Known prototype limitations (carried over from README, still true)

- Single-user, no auth, no concurrency control — filesystem written
  directly on each request.
- Conversation/chat history is intentionally ephemeral (browser-only, by
  design) — `decisions.md` and the chapter files are the persistent record.
- Everything is stateless-per-request by design (§2) — don't introduce
  in-memory session state for the engine; it won't survive a resume cycle
  and breaks the pause/resume mechanism.
