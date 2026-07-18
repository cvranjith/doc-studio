from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from docstudio.models import BuildOptions, BuildRecord
from docstudio.store.documents import DocumentNotFound

router = APIRouter(tags=["export"])


def _state(request: Request):
    return request.app.state.docstudio


class ExportBody(BaseModel):
    word_template: str | None = None  # defaults to the doc type's attached template
    confirm: bool = False
    force_draft_watermark: bool = False


@router.post("/documents/{slug}/export")
def export_document(slug: str, body: ExportBody, request: Request):
    state = _state(request)
    documents = state.documents
    try:
        manifest = documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")

    doc_type_template = state.templates.get_doc_type(manifest.doc_type)
    word_template = body.word_template or doc_type_template.word_template
    if not word_template:
        raise HTTPException(400, "no word template attached to this document type — attach one in Templates")

    non_final = [c.title for c in manifest.chapters if c.status != "final"]
    open_questions = manifest.total_open_questions
    warnings = []
    if non_final:
        warnings.append(f"{len(non_final)} chapter(s) not marked final: {', '.join(non_final)}")
    if open_questions:
        warnings.append(f"{open_questions} open question(s) across chapters")

    if warnings and not body.confirm:
        return {
            "status": "needs_confirmation",
            "warnings": warnings,
            "can_export_draft": True,
        }

    template_path = state.templates.word_template_path(word_template)
    watermark = body.force_draft_watermark or bool(warnings)
    options = BuildOptions(
        word_template=word_template, allow_draft=True, force_draft_watermark=watermark
    )
    out_path = state.formatter.build(documents.doc_dir(slug), template_path, options)

    build = BuildRecord(
        version=manifest.current_version,
        word_template=word_template,
        exported=datetime.now(),
        file=f"exports/{out_path.name}",
        draft_watermark=watermark,
    )
    manifest.builds.append(build)
    documents.save_manifest(manifest)

    return {
        "status": "built",
        "file": build.file,
        "warnings": warnings,
        "draft_watermark": watermark,
        "download_url": f"/api/documents/{slug}/export/download/{out_path.name}",
    }


@router.get("/documents/{slug}/export/download/{filename}")
def download_export(slug: str, filename: str, request: Request):
    state = _state(request)
    path = state.settings.workspace.exports / filename
    if not path.exists():
        raise HTTPException(404, "export not found")
    return FileResponse(
        str(path), filename=filename, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )


@router.post("/documents/{slug}/publish")
def publish_document(slug: str, request: Request):
    state = _state(request)
    try:
        state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    result = state.publisher.publish(state.documents, slug)
    return {
        "target_dir": str(result.target_dir),
        "published_at": result.published_at,
        "version": result.version,
    }
