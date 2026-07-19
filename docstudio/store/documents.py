"""DocumentStore: the single place that reads/writes workspace/documents/<slug>/.

The filesystem IS the database (see requirements.md §2). Every method here
operates directly on doc.yaml / chapter markdown files — no caching, no ORM.
"""
from __future__ import annotations

import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path

import yaml

from docstudio.models import (
    Chapter,
    ChapterFrontmatter,
    ChapterRef,
    DocManifest,
    SourceRef,
)
from docstudio.settings import WorkspacePaths
from docstudio.store.templates import TemplateRegistry

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


_H1_RE = re.compile(r"^#\s+(.+?)\s*$")


def extract_h1_title(body: str) -> str | None:
    """The chapter's leading ``# Heading`` line, if the body starts with
    one — used to keep the chapter title (shown in the card header, the
    Chapters tab, etc.) in sync with the actual heading text, so a rename
    made by editing the heading doesn't leave the two out of sync.
    """
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        m = _H1_RE.match(stripped)
        return m.group(1).strip() if m else None
    return None


def slugify(text: str) -> str:
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-") or "document"


def split_frontmatter(text: str) -> tuple[dict, str]:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    meta = yaml.safe_load(m.group(1)) or {}
    return meta, m.group(2)


def render_frontmatter(meta: dict, body: str) -> str:
    fm = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).strip()
    return f"---\n{fm}\n---\n\n{body.lstrip(chr(10))}"


class DocumentNotFound(Exception):
    pass


class DocumentStore:
    def __init__(self, workspace: WorkspacePaths, templates: TemplateRegistry):
        self.workspace = workspace
        self.templates = templates

    # -- paths ---------------------------------------------------------

    def doc_dir(self, slug: str) -> Path:
        return self.workspace.documents / slug

    def chapters_dir(self, slug: str) -> Path:
        return self.doc_dir(slug) / "chapters"

    def sources_dir(self, slug: str) -> Path:
        return self.doc_dir(slug) / "_sources"

    def originals_dir(self, slug: str) -> Path:
        return self.sources_dir(slug) / "originals"

    def extracted_dir(self, slug: str) -> Path:
        return self.sources_dir(slug) / "extracted"

    def assets_dir(self, slug: str) -> Path:
        return self.doc_dir(slug) / "assets"

    def versions_dir(self, slug: str) -> Path:
        return self.doc_dir(slug) / "versions"

    def decisions_path(self, slug: str) -> Path:
        return self.doc_dir(slug) / "decisions.md"

    def manifest_path(self, slug: str) -> Path:
        return self.doc_dir(slug) / "doc.yaml"

    def chapter_path(self, slug: str, file: str) -> Path:
        return self.chapters_dir(slug) / file

    # -- manifest --------------------------------------------------------

    def exists(self, slug: str) -> bool:
        return self.manifest_path(slug).exists()

    def list_documents(self) -> list[DocManifest]:
        out = []
        if not self.workspace.documents.exists():
            return out
        for d in sorted(self.workspace.documents.iterdir()):
            if (d / "doc.yaml").exists():
                out.append(self.get_manifest(d.name))
        return out

    def get_manifest(self, slug: str) -> DocManifest:
        path = self.manifest_path(slug)
        if not path.exists():
            raise DocumentNotFound(slug)
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return DocManifest.model_validate(data)

    def save_manifest(self, manifest: DocManifest) -> None:
        manifest.updated = datetime.now()
        path = self.manifest_path(manifest.slug)
        data = manifest.model_dump(mode="json")
        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")

    # -- creation --------------------------------------------------------

    def create_document(self, title: str, doc_type: str, client: str = "") -> DocManifest:
        slug = slugify(title)
        base_slug = slug
        n = 2
        while self.exists(slug):
            slug = f"{base_slug}-{n}"
            n += 1

        tpl = self.templates.get_doc_type(doc_type)
        now = datetime.now()

        doc_dir = self.doc_dir(slug)
        (doc_dir / "chapters").mkdir(parents=True, exist_ok=True)
        (doc_dir / "_sources" / "originals").mkdir(parents=True, exist_ok=True)
        (doc_dir / "_sources" / "extracted").mkdir(parents=True, exist_ok=True)
        (doc_dir / "assets").mkdir(parents=True, exist_ok=True)
        (doc_dir / "versions").mkdir(parents=True, exist_ok=True)
        self.decisions_path(slug).write_text(
            f"# Decisions Log — {title}\n\nAnswered clarification Q&A, appended chronologically.\n",
            encoding="utf-8",
        )

        chapter_refs = []
        for spec in tpl.chapters:
            file_name = spec.file_slug
            frontmatter = ChapterFrontmatter(title=spec.title, status="empty", sources_used=[])
            body = f"> _Not yet drafted._\n"
            self.chapter_path(slug, file_name).write_text(
                render_frontmatter(frontmatter.model_dump(mode="json"), body), encoding="utf-8"
            )
            chapter_refs.append(
                ChapterRef(file=file_name, title=spec.title, status="empty", derived=spec.derived, open_questions=0)
            )

        manifest = DocManifest(
            title=title,
            slug=slug,
            doc_type=doc_type,
            template_version=tpl.version,
            client=client,
            author="",
            created=now,
            updated=now,
            status="drafting",
            current_version=0,
            chapters=chapter_refs,
            sources=[],
            builds=[],
        )
        self.save_manifest(manifest)
        return manifest

    def delete_document(self, slug: str) -> None:
        d = self.doc_dir(slug)
        if d.exists():
            shutil.rmtree(d)

    # -- chapters --------------------------------------------------------

    def get_chapter(self, slug: str, file: str) -> Chapter:
        path = self.chapter_path(slug, file)
        if not path.exists():
            raise DocumentNotFound(f"{slug}/{file}")
        meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
        frontmatter = ChapterFrontmatter.model_validate(meta)
        return Chapter(frontmatter=frontmatter, body=body, file=file)

    def list_chapters(self, slug: str) -> list[Chapter]:
        manifest = self.get_manifest(slug)
        return [self.get_chapter(slug, c.file) for c in manifest.chapters]

    def save_chapter(self, slug: str, file: str, body: str, frontmatter: ChapterFrontmatter | None = None) -> Chapter:
        if frontmatter is None:
            existing = self.get_chapter(slug, file)
            frontmatter = existing.frontmatter

        title = extract_h1_title(body)
        if title:
            frontmatter.title = title

        path = self.chapter_path(slug, file)
        path.write_text(render_frontmatter(frontmatter.model_dump(mode="json"), body), encoding="utf-8")

        manifest = self.get_manifest(slug)
        for ref in manifest.chapters:
            if ref.file == file:
                ref.status = frontmatter.status
                if title:
                    ref.title = title
                break
        self.save_manifest(manifest)
        return Chapter(frontmatter=frontmatter, body=body, file=file)

    def update_chapter_status(self, slug: str, file: str, status: str) -> None:
        chapter = self.get_chapter(slug, file)
        chapter.frontmatter.status = status  # type: ignore[assignment]
        self.save_chapter(slug, file, chapter.body, chapter.frontmatter)

    def add_chapter(self, slug: str, title: str, position: int | None = None) -> ChapterRef:
        manifest = self.get_manifest(slug)
        base = f"custom-{slugify(title)}"
        file = f"{base}.md"
        existing_files = {c.file for c in manifest.chapters}
        n = 2
        while file in existing_files:
            file = f"{base}-{n}.md"
            n += 1

        frontmatter = ChapterFrontmatter(title=title, status="empty", sources_used=[])
        self.chapter_path(slug, file).write_text(
            render_frontmatter(frontmatter.model_dump(mode="json"), "> _Not yet drafted._\n"), encoding="utf-8"
        )

        ref = ChapterRef(file=file, title=title, status="empty", derived=False, open_questions=0)
        if position is None:
            # default: insert just before any derived (e.g. glossary) chapters
            position = next((i for i, c in enumerate(manifest.chapters) if c.derived), len(manifest.chapters))
        position = max(0, min(position, len(manifest.chapters)))
        manifest.chapters.insert(position, ref)
        self.save_manifest(manifest)
        return ref

    def delete_chapter(self, slug: str, file: str) -> None:
        manifest = self.get_manifest(slug)
        manifest.chapters = [c for c in manifest.chapters if c.file != file]
        self.save_manifest(manifest)
        path = self.chapter_path(slug, file)
        if path.exists():
            path.unlink()

    def reorder_chapters(self, slug: str, order: list[str]) -> DocManifest:
        manifest = self.get_manifest(slug)
        by_file = {c.file: c for c in manifest.chapters}
        if set(order) != set(by_file.keys()):
            raise ValueError("reorder list must contain exactly the current chapter files")
        manifest.chapters = [by_file[f] for f in order]
        self.save_manifest(manifest)
        return manifest

    def set_open_questions(self, slug: str, file: str, count: int) -> None:
        manifest = self.get_manifest(slug)
        for ref in manifest.chapters:
            if ref.file == file:
                ref.open_questions = count
                break
        self.save_manifest(manifest)

    # -- decisions log -----------------------------------------------------

    def append_decision(self, slug: str, question: str, answer: str, chapter: str | None = None) -> None:
        path = self.decisions_path(slug)
        ts = datetime.now().isoformat(timespec="seconds")
        scope = f" (chapter: {chapter})" if chapter else ""
        entry = f"\n## {ts}{scope}\n\n**Q:** {question}\n\n**A:** {answer}\n"
        with path.open("a", encoding="utf-8") as f:
            f.write(entry)

    # -- sources -----------------------------------------------------------

    def add_source_ref(self, slug: str, source: SourceRef) -> None:
        manifest = self.get_manifest(slug)
        manifest.sources.append(source)
        self.save_manifest(manifest)

    def update_source_ref(self, slug: str, source_id: str, **fields) -> SourceRef:
        manifest = self.get_manifest(slug)
        for s in manifest.sources:
            if s.id == source_id:
                for k, v in fields.items():
                    setattr(s, k, v)
                self.save_manifest(manifest)
                return s
        raise DocumentNotFound(f"source {source_id}")

    def remove_source_ref(self, slug: str, source_id: str) -> None:
        manifest = self.get_manifest(slug)
        manifest.sources = [s for s in manifest.sources if s.id != source_id]
        self.save_manifest(manifest)

    def new_source_id(self) -> str:
        return uuid.uuid4().hex[:12]
