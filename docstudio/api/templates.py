from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from docstudio.models import ChapterSpec, DocTypeTemplate, InterviewQuestion

router = APIRouter(tags=["templates"])

_DOC_TYPE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _state(request: Request):
    return request.app.state.docstudio


@router.get("/templates/doc_types")
def list_doc_types(request: Request):
    state = _state(request)
    return [t.model_dump(mode="json") for t in state.templates.list_doc_types()]


@router.get("/templates/doc_types/{doc_type}")
def get_doc_type(doc_type: str, request: Request):
    state = _state(request)
    try:
        tpl = state.templates.get_doc_type(doc_type)
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")
    return {**tpl.model_dump(mode="json"), "template_variables": state.templates.get_template_variables(doc_type)}


class SaveDocTypeBody(BaseModel):
    name: str
    version: str = "1.0"
    word_template: str = ""
    general_instructions: str = ""
    clarification_policy: str = ""
    chapters: list[ChapterSpec]
    interview_bank: list[InterviewQuestion] = []
    quality_checklist: list[str] = []


@router.put("/templates/doc_types/{doc_type}")
def save_doc_type(doc_type: str, body: SaveDocTypeBody, request: Request):
    state = _state(request)
    tpl = DocTypeTemplate(doc_type=doc_type, **body.model_dump())
    state.templates.save_doc_type(tpl)
    return tpl.model_dump(mode="json")


class RawTemplateBody(BaseModel):
    raw: str


@router.get("/templates/doc_types/{doc_type}/raw")
def get_doc_type_raw(doc_type: str, request: Request):
    state = _state(request)
    try:
        raw = state.templates.get_doc_type_raw(doc_type)
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")
    return {"doc_type": doc_type, "raw": raw}


@router.put("/templates/doc_types/{doc_type}/raw")
def save_doc_type_raw(doc_type: str, body: RawTemplateBody, request: Request):
    state = _state(request)
    try:
        tpl = state.templates.save_doc_type_raw(doc_type, body.raw)
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")
    except Exception as e:
        raise HTTPException(400, f"could not parse template: {e}")
    return {**tpl.model_dump(mode="json"), "template_variables": state.templates.get_template_variables(doc_type)}


class NewDocTypeBody(BaseModel):
    doc_type: str
    raw: str


@router.post("/templates/doc_types")
def create_doc_type(body: NewDocTypeBody, request: Request):
    state = _state(request)
    doc_type = body.doc_type.strip().lower()
    if not _DOC_TYPE_SLUG_RE.match(doc_type):
        raise HTTPException(400, "doc type id must be lowercase letters, numbers, and hyphens")
    try:
        tpl = state.templates.create_doc_type(doc_type, body.raw)
    except FileExistsError:
        raise HTTPException(409, "doc type already exists")
    except Exception as e:
        raise HTTPException(400, f"could not parse template: {e}")
    return {**tpl.model_dump(mode="json"), "template_variables": []}


@router.delete("/templates/doc_types/{doc_type}")
def delete_doc_type(doc_type: str, request: Request):
    state = _state(request)
    try:
        state.templates.delete_doc_type(doc_type)
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")
    return {"deleted": doc_type}


@router.post("/templates/doc_types/{doc_type}/word_template")
async def attach_doc_type_word_template(doc_type: str, request: Request, file: UploadFile):
    state = _state(request)
    try:
        data = await file.read()
        tpl = state.templates.attach_word_template(doc_type, file.filename or "template.docx", data)
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")
    return {**tpl.model_dump(mode="json"), "template_variables": state.templates.get_template_variables(doc_type)}


@router.get("/templates/word")
def list_word_templates(request: Request):
    state = _state(request)
    return state.templates.list_word_templates()


@router.post("/templates/word")
async def upload_word_template(request: Request, file: UploadFile):
    state = _state(request)
    data = await file.read()
    name = state.templates.save_word_template(file.filename or "template.docx", data)
    return {"saved": name}
