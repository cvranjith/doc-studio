"""Thin entrypoint. All logic lives in the docstudio package.

Run with: python app.py   (or: uvicorn app:app --reload)
"""
import uvicorn

from docstudio.api import create_app
from docstudio.settings import load_settings

settings = load_settings()
app = create_app(settings)

if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)
