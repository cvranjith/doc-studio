"""MockReasoningEngine — a stand-in for the future Codex-CLI-backed engine.

Simulates: outline generation, document-scoped drafting (with an occasional
clarification pause), chapter-scoped iteration, and derived-chapter (glossary)
refresh. See docstudio/engine/__init__.py for the interface contract that a
real CodexEngine must satisfy to drop in without touching the API or UI.
"""
from __future__ import annotations

import asyncio
import random
import re
from typing import AsyncIterator

from docstudio.engine import EngineContext
from docstudio.models import (
    ChapterComplete,
    ChapterDelta,
    ChapterSpec,
    Clarification,
    DoneEvent,
    EngineEvent,
    EngineRequest,
    LogEvent,
    ManifestUpdate,
)

# ---------------------------------------------------------------------------
# Domain-flavored lorem generator (banking / payments)
# ---------------------------------------------------------------------------

_SUBJECTS = [
    "the payment gateway", "the settlement engine", "the reconciliation service",
    "the client onboarding workflow", "the core banking platform", "the API gateway layer",
    "the fraud screening module", "the notification service", "the ledger subsystem",
]
_ACTIONS = [
    "must support real-time transaction routing across {rail}",
    "will validate inbound messages against the ISO 20022 schema before posting to the ledger",
    "requires straight-through processing with a target latency under 500ms",
    "integrates with the existing core banking platform via a secured REST interface",
    "must reconcile settlement files on a T+1 basis with automated exception handling",
    "enforces PCI-DSS scope boundaries by tokenizing sensitive card data at ingress",
    "supports both push and pull payment initiation depending on the originating channel",
    "will raise an alert to operations when a transaction exceeds the configured risk threshold",
]
_RAILS = ["FAST", "MEPS+", "SWIFT", "RTGS", "the ACH network"]
_STAKEHOLDERS = [
    "Treasury Operations", "the Compliance team", "the Client Integration squad",
    "Risk & Fraud", "the Core Banking Platform team", "the Client's IT department",
]
_QUALIFIERS = [
    "in line with the client's target operating model",
    "consistent with the bank's enterprise integration standards",
    "as agreed during the discovery workshops",
    "pending final sign-off from the architecture review board",
    "subject to the constraints captured in the client email thread",
]

_ACRONYM_DEFS = {
    "FAST": "Fast And Secure Transfers — Singapore's real-time retail payment rail.",
    "MEPS+": "MAS Electronic Payment System — Singapore's RTGS system for high-value payments.",
    "SWIFT": "Society for Worldwide Interbank Financial Telecommunication — global interbank messaging network.",
    "RTGS": "Real-Time Gross Settlement — settlement of funds transfers individually, in real time.",
    "API": "Application Programming Interface.",
    "PCI-DSS": "Payment Card Industry Data Security Standard.",
    "KYC": "Know Your Customer — identity verification requirements for onboarding.",
    "AML": "Anti-Money Laundering — controls to detect and prevent illicit fund flows.",
    "STP": "Straight-Through Processing — transactions processed without manual intervention.",
    "SLA": "Service Level Agreement.",
    "ISO 20022": "International standard for financial services messaging.",
    "UAT": "User Acceptance Testing.",
    "T+1": "Settlement one business day after the transaction date.",
}


def _sentence() -> str:
    action = random.choice(_ACTIONS).format(rail=random.choice(_RAILS))
    return f"{random.choice(_SUBJECTS).capitalize()} {action}, {random.choice(_QUALIFIERS)}."


def _paragraph(min_sentences: int = 3, max_sentences: int = 5) -> str:
    n = random.randint(min_sentences, max_sentences)
    return " ".join(_sentence() for _ in range(n))


def _stakeholder_list() -> str:
    picks = random.sample(_STAKEHOLDERS, k=min(3, len(_STAKEHOLDERS)))
    return "\n".join(f"- {p}" for p in picks)


# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------

async def _stream_text(chapter: str, text: str, chunk_words: int = 6) -> AsyncIterator[EngineEvent]:
    words = text.split(" ")
    buf: list[str] = []
    for i, w in enumerate(words):
        buf.append(w)
        is_last = i == len(words) - 1
        if len(buf) >= chunk_words or is_last:
            chunk_text = " ".join(buf) + ("" if is_last else " ")
            yield ChapterDelta(chapter=chapter, text_chunk=chunk_text)
            buf = []
            await asyncio.sleep(random.uniform(0.01, 0.04))


def _chapter_body(spec_title: str, prompt: str, chapter_number: str) -> str:
    heading = f"# {spec_title}\n\n"
    prompt_l = prompt.lower()

    if "in-scope" in prompt_l or ("two lists" in prompt_l):
        in_scope = [
            "Payment initiation via the new gateway for retail and corporate channels",
            "Real-time transaction status notifications to the client's core system",
            "Reconciliation and exception reporting for settled transactions",
        ]
        out_scope = [
            "Card issuing and card management services",
            "Historical data migration beyond the last 12 months",
            "Branch teller integration (handled by a separate workstream)",
        ]
        body = heading
        body += "## In Scope\n\n" + "\n".join(f"- {i}" for i in in_scope) + "\n\n"
        body += "## Out of Scope\n\n" + "\n".join(f"- {o}" for o in out_scope) + "\n\n"
        body += _paragraph(2, 3) + "\n"
        return body

    if "stakeholders" in prompt_l:
        body = heading
        body += _paragraph(2, 3) + "\n\n"
        body += "**Key stakeholders:**\n\n" + _stakeholder_list() + "\n\n"
        body += _paragraph(2, 3) + "\n"
        return body

    if "checklist" in prompt_l:
        items = [
            "All in-scope payment rails have a mapped message specification",
            "Non-functional requirements reviewed with the platform team",
            "Security requirements validated against PCI-DSS scope",
        ]
        body = heading + "\n".join(f"- [ ] {i}" for i in items) + "\n\n" + _paragraph(1, 2) + "\n"
        return body

    body = heading
    body += _paragraph(3, 4) + "\n\n"
    body += _paragraph(2, 4) + "\n"
    return body


_GLOSSARY_STOPWORDS = {"The", "This", "In", "Key", "Out", "Not", "Open", "Question", "Clarified", "Revision"}


def _extract_terms(bodies: dict[str, str]) -> set[str]:
    terms: set[str] = set()
    acronym_re = re.compile(r"\b[A-Z]{2,}(?:[+-][A-Z0-9]+)?\b")
    phrase_re = re.compile(r"\b(?:[A-Z][a-zA-Z]*\s){1,2}[A-Z][a-zA-Z]*\b")
    for body in bodies.values():
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue  # headings are chapter/section titles, not glossary terms
            for m in acronym_re.finditer(stripped):
                token = m.group(0)
                if token not in {"OPEN", "QUESTION"}:
                    terms.add(token)
            for m in phrase_re.finditer(stripped):
                phrase = m.group(0).strip()
                if phrase.split()[0] not in _GLOSSARY_STOPWORDS:
                    terms.add(phrase)
    return terms


def _glossary_table(bodies: dict[str, str]) -> str:
    terms = sorted(_extract_terms(bodies))
    rows = ["| Term | Definition |", "|---|---|"]
    for t in terms:
        definition = _ACRONYM_DEFS.get(t, "Domain term referenced across the document chapters.")
        rows.append(f"| {t} | {definition} |")
    if len(rows) == 2:
        rows.append("| _(none found yet)_ | Draft other chapters first, then refresh. |")
    return "# Glossary\n\n" + "\n".join(rows) + "\n"


class MockReasoningEngine:
    """See docstudio/engine/__init__.py::ReasoningEngine for the contract."""

    async def run(self, request: EngineRequest, context: EngineContext) -> AsyncIterator[EngineEvent]:
        instr = request.instruction.lower()
        scope = request.scope

        yield LogEvent(message=f"Engine received instruction (scope={scope!r}): {request.instruction!r}")
        await asyncio.sleep(0.05)

        if scope == "document":
            if "interview" in instr:
                async for ev in self._interview(context):
                    yield ev
            elif "outline" in instr:
                async for ev in self._outline(context):
                    yield ev
            else:
                async for ev in self._draft_document(context):
                    yield ev
        else:
            ref = next((c for c in context.manifest.chapters if c.file == scope), None)
            if ref is None:
                yield LogEvent(message=f"Unknown chapter {scope!r}")
                yield DoneEvent()
                return
            if ref.derived:
                async for ev in self._refresh_derived(context, ref.file, ref.title):
                    yield ev
            else:
                async for ev in self._iterate_chapter(request, context, ref.file, ref.title, ref.status):
                    yield ev

        yield DoneEvent()

    # -- outline ---------------------------------------------------------

    async def _outline(self, context: EngineContext) -> AsyncIterator[EngineEvent]:
        for spec in context.doc_type_template.chapters:
            file = self._file_for(context, spec)
            if file is None:
                continue
            bullets = "\n".join(f"- {line.strip()}" for line in spec.prompt.strip().splitlines() if line.strip())
            stub = f"# {spec.title}\n\n> Outline — to be drafted. This chapter should cover:\n\n{bullets}\n"
            async for ev in _stream_text(file, stub):
                yield ev
            yield ChapterComplete(chapter=file, full_markdown=stub)
            yield ManifestUpdate(chapter=file, status="draft")
            await asyncio.sleep(0.05)

    def _file_for(self, context: EngineContext, spec: ChapterSpec) -> str | None:
        for c in context.manifest.chapters:
            if c.title == spec.title:
                return c.file
        return None

    # -- document-scoped draft with one demo clarification --------------

    async def _draft_document(self, context: EngineContext) -> AsyncIterator[EngineEvent]:
        pending_chapters = [
            c for c in context.manifest.chapters if not c.derived and c.status in ("empty", "drafting")
        ]

        for ref in pending_chapters:
            spec = next((s for s in context.doc_type_template.chapters if s.title == ref.title), None)
            prompt = spec.prompt if spec else ""

            question = self._unresolved_question(context, ref.file)
            if question is not None:
                yield Clarification(
                    question_id=self._question_id(question.q),
                    question=question.q,
                    reason=self._pretext(question, ref.title),
                    choices=list(question.choices),
                    blocking_chapter=ref.file,
                )
                yield LogEvent(message="Paused for clarification. Resume by answering/deferring, then re-run the draft instruction.")
                return

            body = _chapter_body(ref.title, prompt, ref.file)
            if ref.open_questions > 0:
                deferred_q = self._question_for_chapter(context, ref.file)
                if deferred_q:
                    body += f"\n> [OPEN QUESTION: {deferred_q}]\n"
            else:
                answer = self._resolved_answer(context, ref.file)
                if answer:
                    body += f"\n> _Clarified with the consultant: {answer}_\n"
            async for ev in _stream_text(ref.file, body):
                yield ev
            yield ChapterComplete(chapter=ref.file, full_markdown=body)
            yield ManifestUpdate(chapter=ref.file, status="draft")
            await asyncio.sleep(0.08)

        yield LogEvent(message="Document draft complete for all pending chapters.")

    # -- explicit "Interview me" ------------------------------------------
    # Walks the full interview bank in order, independent of which chapters
    # are currently pending — an explicit alternative to letting drafting
    # surface clarifications organically.

    async def _interview(self, context: EngineContext) -> AsyncIterator[EngineEvent]:
        for q in context.doc_type_template.interview_bank:
            if q.q in context.decisions_text:
                continue
            chapter_file = self._file_for_chapter_number(context, q.chapter)
            if chapter_file and "[OPEN QUESTION:" in context.prior_chapter_bodies.get(chapter_file, ""):
                continue
            chapter_title = next((c.title for c in context.manifest.chapters if c.file == chapter_file), q.chapter)
            yield Clarification(
                question_id=self._question_id(q.q),
                question=q.q,
                reason=self._pretext(q, chapter_title),
                choices=list(q.choices),
                blocking_chapter=chapter_file,
            )
            yield LogEvent(message="Paused for interview. Answer or defer, then click “Interview me” again to continue.")
            return
        yield LogEvent(message="No open interview questions remain for this document.")

    def _file_for_chapter_number(self, context: EngineContext, number: str) -> str | None:
        for c in context.manifest.chapters:
            if c.file.startswith(f"{number}-") or c.file == number:
                return c.file
        return None

    def _pretext(self, question, chapter_title: str) -> str:
        base = question.context.strip() if question.context else (
            "This shapes how the chapter is drafted — your answer is recorded in the "
            "decisions log and reflected in the content."
        )
        return f"{base} (Chapter {question.chapter} — {chapter_title})"

    def _unresolved_question(self, context: EngineContext, chapter_file: str):
        ref = next((c for c in context.manifest.chapters if c.file == chapter_file), None)
        if ref is None:
            return None
        # chapter number is the leading digits of the file name, e.g. "02-scope.md" -> "02"
        m = re.match(r"(\d+)", chapter_file)
        number = m.group(1) if m else ""
        for q in context.doc_type_template.interview_bank:
            if q.chapter != number:
                continue
            if q.q in context.decisions_text:
                continue
            if "[OPEN QUESTION:" in context.prior_chapter_bodies.get(chapter_file, ""):
                continue
            return q
        return None

    @staticmethod
    def _question_id(question_text: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", question_text.lower()).strip("-")[:40]

    def _resolved_answer(self, context: EngineContext, chapter_file: str) -> str | None:
        m = re.match(r"(\d+)", chapter_file)
        number = m.group(1) if m else ""
        for q in context.doc_type_template.interview_bank:
            if q.chapter != number:
                continue
            match = re.search(rf"\*\*Q:\*\* {re.escape(q.q)}\s*\n\n\*\*A:\*\* (.+)", context.decisions_text)
            if match and match.group(1).strip() != "(deferred)":
                return match.group(1).strip()
        return None

    def _question_for_chapter(self, context: EngineContext, chapter_file: str) -> str | None:
        m = re.match(r"(\d+)", chapter_file)
        number = m.group(1) if m else ""
        for q in context.doc_type_template.interview_bank:
            if q.chapter == number:
                return q.q
        return None

    # -- chapter-scoped iterate -------------------------------------------

    async def _iterate_chapter(
        self, request: EngineRequest, context: EngineContext, file: str, title: str, status: str = "draft"
    ) -> AsyncIterator[EngineEvent]:
        existing = context.prior_chapter_bodies.get(file, "").strip()
        regenerate = "regenerate" in request.instruction.lower() or not existing or status == "empty"

        if regenerate:
            spec = next((s for s in context.doc_type_template.chapters if s.title == title), None)
            new_body = _chapter_body(title, spec.prompt if spec else "", file)
        else:
            addition = (
                f"\n\n### Revision — {request.instruction.strip()}\n\n"
                f"{_paragraph(2, 3)}"
            )
            new_body = existing + addition

        async for ev in _stream_text(file, new_body):
            yield ev
        yield ChapterComplete(chapter=file, full_markdown=new_body)
        yield ManifestUpdate(chapter=file, status="draft")

    # -- derived chapter refresh (glossary) --------------------------------

    async def _refresh_derived(self, context: EngineContext, file: str, title: str) -> AsyncIterator[EngineEvent]:
        other_bodies = {f: b for f, b in context.prior_chapter_bodies.items() if f != file}
        body = _glossary_table(other_bodies)
        async for ev in _stream_text(file, body):
            yield ev
        yield ChapterComplete(chapter=file, full_markdown=body)
        yield ManifestUpdate(chapter=file, status="draft")
