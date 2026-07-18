from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from docstudio.engine import EngineContext
from docstudio.models import (
    ChapterComplete,
    ChapterFrontmatter,
    EngineRequest,
    ManifestUpdate,
)
from docstudio.store.documents import DocumentNotFound

router = APIRouter(tags=["instruct"])


def _state(request: Request):
    return request.app.state.docstudio


class InstructBody(BaseModel):
    instruction: str
    scope: str = "document"
    checked_source_ids: list[str] = []


def _build_context(state, slug: str) -> EngineContext:
    manifest = state.documents.get_manifest(slug)
    doc_type_template = state.templates.get_doc_type(manifest.doc_type)
    prior_bodies = {c.file: state.documents.get_chapter(slug, c.file).body for c in manifest.chapters}
    decisions_path = state.documents.decisions_path(slug)
    decisions_text = decisions_path.read_text(encoding="utf-8") if decisions_path.exists() else ""
    glossary_chapter = next((c.file for c in manifest.chapters if c.derived), None)
    return EngineContext(
        manifest=manifest,
        doc_type_template=doc_type_template,
        checked_source_extracts={},
        glossary_chapter=glossary_chapter,
        prior_chapter_bodies=prior_bodies,
        decisions_text=decisions_text,
    )


def _checked_extracts(state, slug: str, checked_ids: list[str]) -> dict[str, str]:
    manifest = state.documents.get_manifest(slug)
    out: dict[str, str] = {}
    for s in manifest.sources:
        if s.id in checked_ids and s.extracted:
            path = state.documents.doc_dir(slug) / "_sources" / s.extracted
            if path.exists():
                out[s.id] = path.read_text(encoding="utf-8")
    return out


@router.post("/documents/{slug}/instruct")
async def instruct(slug: str, body: InstructBody, request: Request):
    state = _state(request)
    try:
        state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")

    context = _build_context(state, slug)
    context.checked_source_extracts = _checked_extracts(state, slug, body.checked_source_ids)
    engine_request = EngineRequest(
        instruction=body.instruction, scope=body.scope, checked_source_ids=body.checked_source_ids
    )

    async def event_stream():
        pending_body: dict[str, str] = {}
        async for event in state.engine.run(engine_request, context):
            if isinstance(event, ChapterComplete):
                pending_body[event.chapter] = event.full_markdown
                chapter = state.documents.get_chapter(slug, event.chapter)
                frontmatter = chapter.frontmatter
                frontmatter.sources_used = list(body.checked_source_ids) or frontmatter.sources_used
                frontmatter.last_generated = datetime.now()
                state.documents.save_chapter(slug, event.chapter, event.full_markdown, frontmatter)
            elif isinstance(event, ManifestUpdate) and event.chapter and event.status:
                state.documents.update_chapter_status(slug, event.chapter, event.status)

            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class ClarifyBody(BaseModel):
    question_id: str
    question: str
    chapter: str
    reason: str = ""
    answer: str | None = None
    defer: bool = False


@router.post("/documents/{slug}/clarify")
def clarify(slug: str, body: ClarifyBody, request: Request):
    state = _state(request)
    documents = state.documents
    try:
        manifest = documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")

    if body.defer:
        chapter = documents.get_chapter(slug, body.chapter)
        marker = f"\n> [OPEN QUESTION: {body.question}]\n"
        new_body = chapter.body.rstrip() + "\n" + marker
        documents.save_chapter(slug, body.chapter, new_body, chapter.frontmatter)
        for ref in manifest.chapters:
            if ref.file == body.chapter:
                ref.open_questions += 1
        documents.save_manifest(manifest)
        documents.append_decision(slug, body.question, "(deferred)", chapter=body.chapter)
        return {"status": "deferred", "chapter": body.chapter}

    if not body.answer:
        raise HTTPException(400, "answer is required unless defer=true")

    documents.append_decision(slug, body.question, body.answer, chapter=body.chapter)
    return {"status": "answered", "chapter": body.chapter}
