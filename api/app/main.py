"""FastAPI application: data, models, backtests and jobs."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, jobs
from .config import ensure_dirs
from .routes import backtests as backtest_routes
from .routes import data as data_routes
from .routes import jobs as job_routes
from .routes import models as model_routes

app = FastAPI(title="SOL AI Lab", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    ensure_dirs()
    db.init_db()
    jobs.start_runner()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(job_routes.router)
app.include_router(data_routes.router)
app.include_router(model_routes.router)
app.include_router(backtest_routes.router)
