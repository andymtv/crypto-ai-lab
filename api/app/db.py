"""SQLite metadata: jobs, model runs and backtests. Bulk data lives in files."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH, ensure_dirs

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  result TEXT,
  error TEXT,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL,
  pid INTEGER
);
CREATE TABLE IF NOT EXISTS model_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  params TEXT NOT NULL,
  metrics TEXT,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model_run_id TEXT,
  job_id TEXT,
  status TEXT NOT NULL,
  params TEXT NOT NULL,
  summary TEXT,
  created_at REAL NOT NULL
);
"""


def new_id() -> str:
    return uuid.uuid4().hex[:12]


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")


def row_to_dict(row: sqlite3.Row | None, json_fields: tuple[str, ...] = ()) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for field in json_fields:
        if data.get(field) is not None:
            data[field] = json.loads(data[field])
    return data


def now() -> float:
    return time.time()
