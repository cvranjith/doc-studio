from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from docstudio.store.documents import DocumentNotFound

router = APIRouter(tags=["documents"])


def _state(request: Request):
    return request.app.state.docstudio


@router.get("/documents")
def list_documents(request: Request):
    state = _state(request)
    manifests = state.documents.list_documents()
    return [
        {**m.model_dump(mode="json"), "open_questions": m.total_open_questions}
        for m in manifests
    ]


class CreateDocumentBody(BaseModel):
    title: str
    doc_type: str
    client: str = ""


@router.post("/documents")
def create_document(body: CreateDocumentBody, request: Request):
    state = _state(request)
    try:
        manifest = state.documents.create_document(body.title, body.doc_type, body.client)
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))
    return manifest.model_dump(mode="json")


class UpdateDocumentBody(BaseModel):
    title: str | None = None
    client: str | None = None
    author: str | None = None
    status: str | None = None
    variables: dict[str, str] | None = None  # word-template {VARIABLE} values; full replace


@router.patch("/documents/{slug}")
def update_document(slug: str, payload: UpdateDocumentBody, request: Request):
    state = _state(request)
    try:
        manifest = state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    for field in ("title", "client", "author", "status"):
        value = getattr(payload, field)
        if value is not None:
            setattr(manifest, field, value)
    if payload.variables is not None:
        manifest.variables = payload.variables
    state.documents.save_manifest(manifest)
    return manifest.model_dump(mode="json")


@router.get("/documents/{slug}")
def get_document(slug: str, request: Request):
    state = _state(request)
    try:
        manifest = state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    doc_type = state.templates.get_doc_type(manifest.doc_type)
    return {
        "manifest": manifest.model_dump(mode="json"),
        "doc_type_template": doc_type.model_dump(mode="json"),
        "open_questions": manifest.total_open_questions,
    }


@router.delete("/documents/{slug}")
def delete_document(slug: str, request: Request):
    state = _state(request)
    if not state.documents.exists(slug):
        raise HTTPException(404, "document not found")
    state.documents.delete_document(slug)
    return {"deleted": slug}


@router.get("/documents/{slug}/chapters/{file}")
def get_chapter(slug: str, file: str, request: Request):
    state = _state(request)
    try:
        chapter = state.documents.get_chapter(slug, file)
    except DocumentNotFound:
        raise HTTPException(404, "chapter not found")
    return {
        "file": chapter.file,
        "title": chapter.frontmatter.title,
        "status": chapter.frontmatter.status,
        "sources_used": chapter.frontmatter.sources_used,
        "last_generated": chapter.frontmatter.last_generated,
        "body": chapter.body,
    }


class AddChapterBody(BaseModel):
    title: str
    position: int | None = None


@router.post("/documents/{slug}/chapters")
def add_chapter(slug: str, payload: AddChapterBody, request: Request):
    state = _state(request)
    try:
        state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    if not payload.title.strip():
        raise HTTPException(400, "title is required")
    ref = state.documents.add_chapter(slug, payload.title.strip(), payload.position)
    return ref.model_dump(mode="json")


class ReorderChaptersBody(BaseModel):
    order: list[str]


@router.post("/documents/{slug}/chapters/reorder")
def reorder_chapters(slug: str, payload: ReorderChaptersBody, request: Request):
    state = _state(request)
    try:
        manifest = state.documents.reorder_chapters(slug, payload.order)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return manifest.model_dump(mode="json")


@router.delete("/documents/{slug}/chapters/{file}")
def delete_chapter(slug: str, file: str, request: Request):
    state = _state(request)
    try:
        state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    state.documents.delete_chapter(slug, file)
    return {"deleted": file}


class SaveChapterBody(BaseModel):
    body: str | None = None
    status: str | None = None
    title: str | None = None


@router.put("/documents/{slug}/chapters/{file}")
def save_chapter(slug: str, file: str, payload: SaveChapterBody, request: Request):
    state = _state(request)
    try:
        chapter = state.documents.get_chapter(slug, file)
    except DocumentNotFound:
        raise HTTPException(404, "chapter not found")

    frontmatter = chapter.frontmatter
    if payload.status is not None:
        frontmatter.status = payload.status  # type: ignore[assignment]
    if payload.title is not None:
        frontmatter.title = payload.title
    body = payload.body if payload.body is not None else chapter.body

    updated = state.documents.save_chapter(slug, file, body, frontmatter)
    return {
        "file": updated.file,
        "title": updated.frontmatter.title,
        "status": updated.frontmatter.status,
        "sources_used": updated.frontmatter.sources_used,
        "last_generated": updated.frontmatter.last_generated,
        "body": updated.body,
    }
