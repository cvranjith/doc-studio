"""Source ingestion (requirements.md §6). Dispatches by extension into
_sources/extracted/ as markdown. Extraction failures never block the upload —
the source stays usable as a label-only reference.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

TEXT_EXTS = {".md", ".txt"}
PDF_EXTS = {".pdf"}
DOCX_EXTS = {".docx"}
SHEET_EXTS = {".xlsx", ".csv"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg"}

ACCEPTED_EXTS = TEXT_EXTS | PDF_EXTS | DOCX_EXTS | SHEET_EXTS | IMAGE_EXTS


@dataclass
class ExtractionResult:
    status: str  # ok | failed | unsupported
    markdown: str | None = None
    error: str | None = None


def extract(path: Path) -> ExtractionResult:
    suffix = path.suffix.lower()
    try:
        if suffix in TEXT_EXTS:
            from docstudio.ingest.text import extract_text

            return ExtractionResult(status="ok", markdown=extract_text(path))
        if suffix in PDF_EXTS:
            from docstudio.ingest.pdf import extract_pdf

            return ExtractionResult(status="ok", markdown=extract_pdf(path))
        if suffix in DOCX_EXTS:
            from docstudio.ingest.docx import extract_docx

            return ExtractionResult(status="ok", markdown=extract_docx(path))
        if suffix in SHEET_EXTS:
            from docstudio.ingest.spreadsheet import extract_spreadsheet

            return ExtractionResult(status="ok", markdown=extract_spreadsheet(path))
        return ExtractionResult(status="unsupported")
    except Exception as exc:  # extraction must never block upload
        return ExtractionResult(status="failed", error=str(exc))
