"""Typed models for everything that touches the filesystem contract or the
engine interface. Pydantic v2. Nothing here talks to disk — see docstudio/store.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field

ChapterStatus = Literal["empty", "drafting", "draft", "reviewed", "final"]
DocStatus = Literal["drafting", "review", "final"]
SourceMode = Literal["source", "embed"]
ExtractionStatus = Literal["pending", "ok", "failed", "unsupported"]


# ---------------------------------------------------------------------------
# doc.yaml manifest
# ---------------------------------------------------------------------------

class ChapterRef(BaseModel):
    file: str
    title: str
    status: ChapterStatus = "empty"
    derived: bool = False
    open_questions: int = 0


class SourceRef(BaseModel):
    id: str
    file: str
    extracted: Optional[str] = None
    label: str
    mode: SourceMode = "source"
    extraction_status: ExtractionStatus = "pending"
    content_type: Optional[str] = None


class BuildRecord(BaseModel):
    version: int
    word_template: str
    exported: datetime
    file: str
    draft_watermark: bool = False


class PublishedInfo(BaseModel):
    last_version: Optional[int] = None
    last_published: Optional[datetime] = None


class DocManifest(BaseModel):
    title: str
    slug: str
    doc_type: str
    template_version: str = "1.0"
    client: str = ""
    author: str = ""
    created: datetime
    updated: datetime
    status: DocStatus = "drafting"
    current_version: int = 0
    chapters: list[ChapterRef] = Field(default_factory=list)
    sources: list[SourceRef] = Field(default_factory=list)
    builds: list[BuildRecord] = Field(default_factory=list)
    published: PublishedInfo = Field(default_factory=PublishedInfo)

    @property
    def total_open_questions(self) -> int:
        return sum(c.open_questions for c in self.chapters)


class ChapterFrontmatter(BaseModel):
    title: str
    status: ChapterStatus = "draft"
    sources_used: list[str] = Field(default_factory=list)
    last_generated: Optional[datetime] = None


class Chapter(BaseModel):
    """A chapter's frontmatter + body, as read from / written to disk."""

    frontmatter: ChapterFrontmatter
    body: str
    file: str


# ---------------------------------------------------------------------------
# Doc-type templates (templates/doc_types/*.md)
# ---------------------------------------------------------------------------

class ChapterSpec(BaseModel):
    number: str  # "01", "90", ...
    title: str
    required: bool = True
    derived: bool = False
    prompt: str = ""

    @property
    def file_slug(self) -> str:
        slug = self.title.lower().strip()
        slug = "".join(c if c.isalnum() else "-" for c in slug)
        while "--" in slug:
            slug = slug.replace("--", "-")
        return f"{self.number}-{slug.strip('-')}.md"


class InterviewQuestion(BaseModel):
    q: str
    chapter: str
    choices: list[str] = Field(default_factory=list)
    context: str = ""  # optional pretext explaining why this is being asked


class DocTypeTemplate(BaseModel):
    doc_type: str
    name: str
    version: str = "1.0"
    word_template: str = ""
    chapters: list[ChapterSpec] = Field(default_factory=list)
    interview_bank: list[InterviewQuestion] = Field(default_factory=list)
    quality_checklist: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Reasoning engine interface types (§7)
# ---------------------------------------------------------------------------

EngineScope = Union[Literal["document"], str]  # "document" or a chapter file name


class EngineRequest(BaseModel):
    instruction: str
    scope: str = "document"  # "document" | chapter file name
    checked_source_ids: list[str] = Field(default_factory=list)
    session_answers: dict[str, str] = Field(default_factory=dict)


class ChapterDelta(BaseModel):
    type: Literal["chapter_delta"] = "chapter_delta"
    chapter: str
    text_chunk: str


class ChapterComplete(BaseModel):
    type: Literal["chapter_complete"] = "chapter_complete"
    chapter: str
    full_markdown: str


class Clarification(BaseModel):
    type: Literal["clarification"] = "clarification"
    question_id: str
    question: str
    reason: str = ""
    choices: list[str] = Field(default_factory=list)
    blocking_chapter: Optional[str] = None


class ManifestUpdate(BaseModel):
    type: Literal["manifest_update"] = "manifest_update"
    chapter: Optional[str] = None
    status: Optional[ChapterStatus] = None
    open_questions: Optional[int] = None


class LogEvent(BaseModel):
    type: Literal["log"] = "log"
    message: str


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"


EngineEvent = Union[ChapterDelta, ChapterComplete, Clarification, ManifestUpdate, LogEvent, DoneEvent]


# ---------------------------------------------------------------------------
# DocFormatter interface types (§8)
# ---------------------------------------------------------------------------

class BuildOptions(BaseModel):
    word_template: str = "corporate-default.docx"
    allow_draft: bool = True
    force_draft_watermark: bool = False
