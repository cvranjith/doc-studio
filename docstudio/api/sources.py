from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from docstudio import ingest
from docstudio.models import SourceRef
from docstudio.store.documents import DocumentNotFound

router = APIRouter(tags=["sources"])


def _state(request: Request):
    return request.app.state.docstudio


@router.post("/documents/{slug}/sources")
async def upload_source(slug: str, request: Request, file: UploadFile):
    state = _state(request)
    documents = state.documents
    try:
        documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")

    filename = Path(file.filename or "upload").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ingest.ACCEPTED_EXTS:
        raise HTTPException(400, f"unsupported file type: {suffix or '(none)'}")

    original_path = documents.originals_dir(slug) / filename
    original_path.parent.mkdir(parents=True, exist_ok=True)
    data = await file.read()
    original_path.write_bytes(data)

    result = ingest.extract(original_path)
    extracted_rel = None
    if result.status == "ok" and result.markdown is not None:
        extracted_dir = documents.extracted_dir(slug)
        extracted_dir.mkdir(parents=True, exist_ok=True)
        extracted_name = f"{Path(filename).stem}.md"
        (extracted_dir / extracted_name).write_text(result.markdown, encoding="utf-8")
        extracted_rel = f"extracted/{extracted_name}"

    source = SourceRef(
        id=documents.new_source_id(),
        file=f"originals/{filename}",
        extracted=extracted_rel,
        label=filename,
        mode="source",
        extraction_status=result.status,  # type: ignore[arg-type]
        content_type=file.content_type,
    )
    documents.add_source_ref(slug, source)
    return source.model_dump(mode="json") | ({"error": result.error} if result.error else {})


class UpdateSourceBody(BaseModel):
    label: str | None = None
    mode: str | None = None


@router.patch("/documents/{slug}/sources/{source_id}")
def update_source(slug: str, source_id: str, payload: UpdateSourceBody, request: Request):
    state = _state(request)
    fields = {k: v for k, v in payload.model_dump().items() if v is not None}
    try:
        updated = state.documents.update_source_ref(slug, source_id, **fields)
    except DocumentNotFound:
        raise HTTPException(404, "source not found")
    return updated.model_dump(mode="json")


@router.delete("/documents/{slug}/sources/{source_id}")
def delete_source(slug: str, source_id: str, request: Request):
    state = _state(request)
    documents = state.documents
    manifest = documents.get_manifest(slug)
    source = next((s for s in manifest.sources if s.id == source_id), None)
    if source is None:
        raise HTTPException(404, "source not found")

    original = documents.doc_dir(slug) / source.file
    if original.exists():
        original.unlink()
    if source.extracted:
        extracted = documents.doc_dir(slug) / "_sources" / source.extracted
        if extracted.exists():
            extracted.unlink()

    documents.remove_source_ref(slug, source_id)
    return {"deleted": source_id}


@router.get("/documents/{slug}/sources/{source_id}/extracted")
def get_extracted(slug: str, source_id: str, request: Request):
    state = _state(request)
    documents = state.documents
    manifest = documents.get_manifest(slug)
    source = next((s for s in manifest.sources if s.id == source_id), None)
    if source is None:
        raise HTTPException(404, "source not found")
    if not source.extracted:
        return {"extracted": None, "status": source.extraction_status}
    path = documents.doc_dir(slug) / "_sources" / source.extracted
    if not path.exists():
        return {"extracted": None, "status": "failed"}
    return {"extracted": path.read_text(encoding="utf-8"), "status": source.extraction_status}
