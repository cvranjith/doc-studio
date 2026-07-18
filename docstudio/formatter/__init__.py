"""DocFormatter interface (requirements.md §8).

``TemplatedDocFormatter`` (docstudio/formatter/templated.py) is a real,
working implementation: it injects chapters at a ``{CHAPTERS}`` marker in
the doc type's attached Word template using the template's own named
styles, fills in ``{VARIABLE}`` tokens, and strips an optional
``##STYLES_START##``/``##STYLES_END##`` style-reference block. It does not
yet render Mermaid diagrams to images or embed-mode source tables — those
remain future work. To replace it with a different implementation:
implement ``DocFormatter.build`` and register it in
``docstudio/api/__init__.py::AppState`` in place of
``TemplatedDocFormatter``. Nothing else changes — the export API and UI
only depend on this interface.
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
