"""Publish to ANTiRAG Knowledge Base (requirements.md §10).

Prototype: filesystem copy. Later: ANTiRAG API call or a git-commit
one-liner — swap the implementation behind this Protocol without touching
the API layer.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from docstudio.settings import Settings
from docstudio.store.documents import DocumentStore


@dataclass
class PublishResult:
    target_dir: Path
    published_at: datetime
    version: int


class Publisher(Protocol):
    def publish(self, documents: DocumentStore, slug: str) -> PublishResult: ...


class FilesystemPublisher:
    def __init__(self, settings: Settings):
        self.settings = settings

    def publish(self, documents: DocumentStore, slug: str) -> PublishResult:
        manifest = documents.get_manifest(slug)
        target_dir = self.settings.knowledge_base_target / slug

        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)

        shutil.copytree(documents.chapters_dir(slug), target_dir / "chapters")
        shutil.copy2(documents.manifest_path(slug), target_dir / "doc.yaml")

        assets_dir = documents.assets_dir(slug)
        referenced = self._referenced_assets(documents, slug)
        if assets_dir.exists() and referenced:
            (target_dir / "assets").mkdir(parents=True, exist_ok=True)
            for name in referenced:
                src = assets_dir / name
                if src.exists():
                    shutil.copy2(src, target_dir / "assets" / name)

        now = datetime.now()
        manifest.published.last_version = manifest.current_version
        manifest.published.last_published = now
        documents.save_manifest(manifest)

        return PublishResult(target_dir=target_dir, published_at=now, version=manifest.current_version)

    def _referenced_assets(self, documents: DocumentStore, slug: str) -> set[str]:
        assets_dir = documents.assets_dir(slug)
        if not assets_dir.exists():
            return set()
        all_assets = {p.name for p in assets_dir.iterdir() if p.is_file()}
        referenced: set[str] = set()
        for chapter_path in documents.chapters_dir(slug).glob("*.md"):
            text = chapter_path.read_text(encoding="utf-8")
            for name in all_assets:
                if name in text:
                    referenced.add(name)
        return referenced
