from __future__ import annotations

import yaml
from fastapi import APIRouter, HTTPException, Request

from docstudio.models import DocManifest
from docstudio.store.documents import DocumentNotFound, split_frontmatter

router = APIRouter(tags=["versions"])


def _state(request: Request):
    return request.app.state.docstudio


@router.post("/documents/{slug}/versions")
def save_version(slug: str, request: Request):
    state = _state(request)
    try:
        state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    info = state.versions.save_version(slug)
    return {"version": info.version, "created": info.created, "status": info.status}


@router.get("/documents/{slug}/versions")
def list_versions(slug: str, request: Request):
    state = _state(request)
    return [
        {"version": v.version, "created": v.created, "status": v.status}
        for v in state.versions.list_versions(slug)
    ]


@router.get("/documents/{slug}/versions/{version}")
def get_version(slug: str, version: int, request: Request):
    state = _state(request)
    vdir = state.versions.version_dir(slug, version)
    manifest_path = vdir / "doc.yaml"
    if not manifest_path.exists():
        raise HTTPException(404, "version not found")
    manifest = DocManifest.model_validate(yaml.safe_load(manifest_path.read_text(encoding="utf-8")))
    return manifest.model_dump(mode="json")


@router.get("/documents/{slug}/versions/{version}/chapters/{file}")
def get_version_chapter(slug: str, version: int, file: str, request: Request):
    state = _state(request)
    path = state.versions.version_dir(slug, version) / "chapters" / file
    if not path.exists():
        raise HTTPException(404, "chapter not found in this version")
    meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
    return {"file": file, "title": meta.get("title", file), "status": meta.get("status"), "body": body}


@router.get("/documents/{slug}/versions/{version}/diff/{file}")
def diff_chapter(slug: str, version: int, file: str, request: Request):
    state = _state(request)
    try:
        state.documents.get_manifest(slug)
    except DocumentNotFound:
        raise HTTPException(404, "document not found")
    diff_text = state.versions.diff_chapter(slug, version, file)
    return {"version": version, "file": file, "diff": diff_text}


@router.post("/documents/{slug}/restore/{version}")
def restore_version(slug: str, version: int, request: Request):
    state = _state(request)
    try:
        info = state.versions.restore(slug, version)
    except FileNotFoundError:
        raise HTTPException(404, "version not found")
    return {"restored_to": info.version, "current_version": state.documents.get_manifest(slug).current_version}
