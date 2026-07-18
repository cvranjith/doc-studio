from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from docstudio.models import ChapterSpec, DocTypeTemplate, InterviewQuestion

router = APIRouter(tags=["templates"])


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
        return state.templates.get_doc_type(doc_type).model_dump(mode="json")
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")


class SaveDocTypeBody(BaseModel):
    name: str
    version: str = "1.0"
    word_template: str = ""
    chapters: list[ChapterSpec]
    interview_bank: list[InterviewQuestion] = []
    quality_checklist: list[str] = []


@router.put("/templates/doc_types/{doc_type}")
def save_doc_type(doc_type: str, body: SaveDocTypeBody, request: Request):
    state = _state(request)
    tpl = DocTypeTemplate(doc_type=doc_type, **body.model_dump())
    state.templates.save_doc_type(tpl)
    return tpl.model_dump(mode="json")


@router.post("/templates/doc_types/{doc_type}/word_template")
async def attach_doc_type_word_template(doc_type: str, request: Request, file: UploadFile):
    state = _state(request)
    try:
        data = await file.read()
        tpl = state.templates.attach_word_template(doc_type, file.filename or "template.docx", data)
    except FileNotFoundError:
        raise HTTPException(404, "unknown doc type")
    return tpl.model_dump(mode="json")


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
