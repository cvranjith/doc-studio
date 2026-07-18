"""ReasoningEngine interface (requirements.md §7).

A future ``CodexEngine`` will shell out to Codex CLI and stream its stdout as
``EngineEvent``s. To drop it in: implement ``ReasoningEngine.run`` below,
register it in ``docstudio/api/__init__.py::AppState`` in place of
``MockReasoningEngine``. Nothing else — routers and the frontend only ever
see ``EngineEvent`` objects, never engine-specific detail.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Protocol

from docstudio.models import (
    DocManifest,
    DocTypeTemplate,
    EngineEvent,
    EngineRequest,
)


@dataclass
class EngineContext:
    """Everything the engine needs beyond the raw instruction: assembled by
    the instruct API handler from the DocumentStore before calling ``run``.
    """

    manifest: DocManifest
    doc_type_template: DocTypeTemplate
    checked_source_extracts: dict[str, str]  # source id -> extracted markdown
    glossary_chapter: str | None
    prior_chapter_bodies: dict[str, str]  # file -> body, for chapters relevant to scope
    decisions_text: str = ""


class ReasoningEngine(Protocol):
    async def run(self, request: EngineRequest, context: EngineContext) -> AsyncIterator[EngineEvent]:
        """Yield EngineEvents as the instruction is carried out. Must
        eventually yield a DoneEvent. Implementations should be safe to
        cancel mid-stream (e.g. client disconnect).
        """
        ...
