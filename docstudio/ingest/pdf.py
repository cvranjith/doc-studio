from pathlib import Path

from pypdf import PdfReader


def extract_pdf(path: Path) -> str:
    reader = PdfReader(str(path))
    parts = [f"# {path.name}\n"]
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        parts.append(f"\n## Page {i}\n\n{text or '_(no extractable text)_'}\n")
    return "\n".join(parts)
