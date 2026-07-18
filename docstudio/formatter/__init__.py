"""DocFormatter interface (requirements.md §8).

A real implementation will concatenate chapters in manifest order, render
Mermaid blocks to images, embed assets/ images, render embed-mode sources as
tables, and inject into the corporate Word template's placeholders. To drop
one in: implement ``DocFormatter.build`` below and register it in
``docstudio/api/__init__.py::AppState`` in place of ``MockDocFormatter``.
Nothing else changes — the export API and UI only depend on this interface.
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from docstudio.models import BuildOptions


class DocFormatter(Protocol):
    def build(self, document_dir: Path, word_template: Path, options: BuildOptions) -> Path:
        """Produce a .docx in <document_dir>/../../exports (or wherever the
        caller directs) and return its path. Callers are responsible for
        validation (open questions / chapter status) before calling build —
        see docstudio/api/export.py.
        """
        ...
