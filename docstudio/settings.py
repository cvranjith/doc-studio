"""App configuration loading.

Two config files are involved:
- ``<project>/config.yaml`` (or $DOCSTUDIO_CONFIG): app-level, says where the
  workspace root is plus host/port.
- ``<workspace_root>/config.yaml``: workspace-level, holds settings that
  travel with the workspace itself (e.g. knowledge_base_path). Seeded on
  first run if missing.

Everything is filesystem-relative; there is no database.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

APP_CONFIG_ENV = "DOCSTUDIO_CONFIG"
WORKSPACE_ROOT_ENV = "DOCSTUDIO_WORKSPACE_ROOT"

DEFAULT_WORKSPACE_CONFIG = {
    "knowledge_base_path": "./knowledge_base",
    "knowledge_base_subpath": "docstudio",
}


@dataclass
class WorkspacePaths:
    """Resolved, ready-to-use paths within a workspace root."""

    root: Path
    documents: Path = field(init=False)
    templates: Path = field(init=False)
    doc_type_templates: Path = field(init=False)
    word_templates: Path = field(init=False)
    exports: Path = field(init=False)
    config_file: Path = field(init=False)

    def __post_init__(self) -> None:
        self.documents = self.root / "documents"
        self.templates = self.root / "templates"
        self.doc_type_templates = self.templates / "doc_types"
        self.word_templates = self.templates / "word_templates"
        self.exports = self.root / "exports"
        self.config_file = self.root / "config.yaml"

    def ensure(self) -> None:
        for p in (self.documents, self.doc_type_templates, self.word_templates, self.exports):
            p.mkdir(parents=True, exist_ok=True)


@dataclass
class Settings:
    project_root: Path
    host: str
    port: int
    workspace: WorkspacePaths
    knowledge_base_path: Path
    knowledge_base_subpath: str

    @property
    def knowledge_base_target(self) -> Path:
        return self.knowledge_base_path / self.knowledge_base_subpath


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_settings(project_root: Path | None = None) -> Settings:
    project_root = (project_root or Path.cwd()).resolve()

    app_config_path = Path(os.environ.get(APP_CONFIG_ENV, project_root / "config.yaml"))
    if not app_config_path.is_absolute():
        app_config_path = project_root / app_config_path
    app_cfg = _load_yaml(app_config_path)

    workspace_root_raw = os.environ.get(WORKSPACE_ROOT_ENV) or app_cfg.get("workspace_root", "./workspace")
    workspace_root = Path(workspace_root_raw)
    if not workspace_root.is_absolute():
        workspace_root = (project_root / workspace_root).resolve()

    paths = WorkspacePaths(root=workspace_root)
    paths.ensure()

    if not paths.config_file.exists():
        with paths.config_file.open("w", encoding="utf-8") as f:
            yaml.safe_dump(DEFAULT_WORKSPACE_CONFIG, f, sort_keys=False)

    ws_cfg = {**DEFAULT_WORKSPACE_CONFIG, **_load_yaml(paths.config_file)}

    kb_path_raw = ws_cfg.get("knowledge_base_path", DEFAULT_WORKSPACE_CONFIG["knowledge_base_path"])
    kb_path = Path(kb_path_raw)
    if not kb_path.is_absolute():
        kb_path = (workspace_root / kb_path).resolve()

    return Settings(
        project_root=project_root,
        host=app_cfg.get("host", "127.0.0.1"),
        port=int(app_cfg.get("port", 8000)),
        workspace=paths,
        knowledge_base_path=kb_path,
        knowledge_base_subpath=ws_cfg.get("knowledge_base_subpath", "docstudio"),
    )
