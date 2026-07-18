"""FastAPI app factory. Wires routers + static frontend onto a Settings/stores bundle."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from docstudio.settings import Settings, load_settings
from docstudio.store.documents import DocumentStore
from docstudio.store.templates import TemplateRegistry
from docstudio.store.versions import FolderSnapshotVersionStore
from docstudio.store.publisher import FilesystemPublisher
from docstudio.engine.mock import MockReasoningEngine
from docstudio.formatter.mock import MockDocFormatter

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class AppState:
    """Holds the wired-up store/engine instances the routers depend on."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.templates = TemplateRegistry(settings.workspace)
        self.documents = DocumentStore(settings.workspace, self.templates)
        self.versions = FolderSnapshotVersionStore(self.documents)
        self.publisher = FilesystemPublisher(settings)
        self.engine = MockReasoningEngine()
        self.formatter = MockDocFormatter()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    state = AppState(settings)

    from docstudio.store.seed import seed_workspace

    seed_workspace(state)

    app = FastAPI(title="Document Studio", version="0.1.0")
    app.state.docstudio = state

    from docstudio.api import documents as documents_router
    from docstudio.api import sources as sources_router
    from docstudio.api import instruct as instruct_router
    from docstudio.api import versions as versions_router
    from docstudio.api import export as export_router
    from docstudio.api import templates as templates_router

    app.include_router(documents_router.router, prefix="/api")
    app.include_router(sources_router.router, prefix="/api")
    app.include_router(instruct_router.router, prefix="/api")
    app.include_router(versions_router.router, prefix="/api")
    app.include_router(export_router.router, prefix="/api")
    app.include_router(templates_router.router, prefix="/api")

    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app
