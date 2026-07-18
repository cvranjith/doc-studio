"""Local, folder-snapshot based versioning (requirements.md §9).

Kept behind a small Protocol so a Git-backed implementation could replace
folder snapshots later without touching the API layer.
"""
from __future__ import annotations

import difflib
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

import yaml

from docstudio.store.documents import DocumentStore


@dataclass
class VersionInfo:
    version: int
    created: datetime
    status: str


class VersionStore(Protocol):
    def save_version(self, slug: str) -> VersionInfo: ...
    def list_versions(self, slug: str) -> list[VersionInfo]: ...
    def diff_chapter(self, slug: str, version: int, chapter_file: str) -> str: ...
    def restore(self, slug: str, version: int) -> VersionInfo: ...


class FolderSnapshotVersionStore:
    """Copies chapters/, doc.yaml, decisions.md into versions/vN/.
    Sources and assets are not snapshotted (they're append-mostly; referenced
    in place).
    """

    def __init__(self, documents: DocumentStore):
        self.documents = documents

    def version_dir(self, slug: str, version: int) -> Path:
        return self.documents.versions_dir(slug) / f"v{version}"

    def _meta_path(self, slug: str, version: int) -> Path:
        return self.version_dir(slug, version) / "version.yaml"

    def save_version(self, slug: str) -> VersionInfo:
        manifest = self.documents.get_manifest(slug)
        new_version = manifest.current_version + 1
        vdir = self.version_dir(slug, new_version)
        vdir.mkdir(parents=True, exist_ok=True)

        shutil.copytree(self.documents.chapters_dir(slug), vdir / "chapters", dirs_exist_ok=True)
        shutil.copy2(self.documents.manifest_path(slug), vdir / "doc.yaml")
        if self.documents.decisions_path(slug).exists():
            shutil.copy2(self.documents.decisions_path(slug), vdir / "decisions.md")

        created = datetime.now()
        info = VersionInfo(version=new_version, created=created, status=manifest.status)
        self._meta_path(slug, new_version).write_text(
            yaml.safe_dump({"version": new_version, "created": created.isoformat(), "status": manifest.status}),
            encoding="utf-8",
        )

        manifest.current_version = new_version
        self.documents.save_manifest(manifest)
        return info

    def list_versions(self, slug: str) -> list[VersionInfo]:
        vdir_root = self.documents.versions_dir(slug)
        if not vdir_root.exists():
            return []
        out = []
        for d in sorted(vdir_root.iterdir(), key=lambda p: p.name):
            meta_path = d / "version.yaml"
            if not meta_path.exists():
                continue
            meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
            out.append(
                VersionInfo(
                    version=meta["version"],
                    created=datetime.fromisoformat(meta["created"]),
                    status=meta.get("status", ""),
                )
            )
        out.sort(key=lambda v: v.version)
        return out

    def diff_chapter(self, slug: str, version: int, chapter_file: str) -> str:
        old_path = self.version_dir(slug, version) / "chapters" / chapter_file
        new_path = self.documents.chapter_path(slug, chapter_file)
        old_lines = old_path.read_text(encoding="utf-8").splitlines(keepends=True) if old_path.exists() else []
        new_lines = new_path.read_text(encoding="utf-8").splitlines(keepends=True) if new_path.exists() else []
        diff = difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=f"v{version}/{chapter_file}",
            tofile=f"current/{chapter_file}",
        )
        return "".join(diff)

    def restore(self, slug: str, version: int) -> VersionInfo:
        src = self.version_dir(slug, version)
        if not src.exists():
            raise FileNotFoundError(f"version v{version} not found for {slug}")

        # Never destructive: snapshot current state first.
        pre_restore = self.save_version(slug)

        chapters_dir = self.documents.chapters_dir(slug)
        shutil.rmtree(chapters_dir)
        shutil.copytree(src / "chapters", chapters_dir)
        shutil.copy2(src / "doc.yaml", self.documents.manifest_path(slug))
        if (src / "decisions.md").exists():
            shutil.copy2(src / "decisions.md", self.documents.decisions_path(slug))

        # Keep the forward-incrementing version counter; restored content is
        # now "live" (not itself a new snapshot) at the post-auto-save count.
        manifest = self.documents.get_manifest(slug)
        manifest.current_version = pre_restore.version
        self.documents.save_manifest(manifest)

        return VersionInfo(version=version, created=datetime.now(), status=manifest.status)
