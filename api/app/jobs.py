"""Background jobs (downloads, dataset builds, training, backtests).

Each job runs in its own detached worker process (`python -m app.worker <id>`)
so it survives API reloads and a crash cannot take the API down. Jobs run one
at a time: the machine has little RAM and every job is memory-hungry.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Any

from . import db
from .config import JOBS_DIR, ensure_dirs

JOB_KINDS = ("download", "build_series", "build_features", "train", "backtest")

_runner_started = False


class JobCancelled(Exception):
    pass


def create_job(kind: str, params: dict[str, Any]) -> dict[str, Any]:
    if kind not in JOB_KINDS:
        raise ValueError(f"Unknown job kind: {kind}")
    job_id = db.new_id()
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO jobs (id, kind, params, status, created_at) VALUES (?, ?, ?, 'queued', ?)",
            (job_id, kind, json.dumps(params), db.now()),
        )
    return get_job(job_id)  # type: ignore[return-value]


def get_job(job_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return db.row_to_dict(row, ("params", "result"))


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [db.row_to_dict(row, ("params", "result")) for row in rows]  # type: ignore[misc]


def cancel_job(job_id: str) -> dict[str, Any] | None:
    job = get_job(job_id)
    if job is None:
        return None
    if job["status"] == "queued":
        _finish(job_id, "cancelled", error="Cancelled before it started.")
    elif job["status"] == "running" and job.get("pid"):
        try:
            os.killpg(job["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
        _finish(job_id, "cancelled", error="Cancelled while running.")
    return get_job(job_id)


def read_log(job_id: str, tail: int = 200) -> list[str]:
    path = JOBS_DIR / f"{job_id}.log"
    if not path.exists():
        return []
    return path.read_text(errors="replace").splitlines()[-tail:]


def _finish(job_id: str, status: str, result: Any = None, error: str | None = None) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')",
            (status, json.dumps(result) if result is not None else None, error, db.now(), job_id),
        )


def _pid_alive(pid: int | None, job_id: str) -> bool:
    """True if `pid` is still this job's worker (PIDs are reused after a container restart)."""
    if not pid:
        return False
    # Reap our own finished child first, or it lingers as a zombie.
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)
        if reaped == pid:
            return False
    except ChildProcessError:
        pass  # not our child (e.g. started before an API reload)
    try:
        cmdline = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
    except OSError:
        return False
    return b"app.worker" in cmdline and job_id.encode() in cmdline


def _reap_dead_running_jobs() -> bool:
    """Marks running jobs whose worker died as failed. Returns True if one is still alive."""
    alive = False
    with db.connect() as conn:
        rows = conn.execute("SELECT id, pid FROM jobs WHERE status = 'running'").fetchall()
    for row in rows:
        if _pid_alive(row["pid"], row["id"]):
            alive = True
        else:
            _finish(row["id"], "failed", error="Worker process exited unexpectedly (see the job log).")
    return alive


def _launch_next() -> None:
    with db.connect() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").fetchone()
    if row is None:
        return
    job_id = row["id"]
    ensure_dirs()
    log = open(JOBS_DIR / f"{job_id}.log", "ab")
    process = subprocess.Popen(
        [sys.executable, "-m", "app.worker", job_id],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    with db.connect() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE id = ?",
            (process.pid, db.now(), job_id),
        )


def _runner_loop() -> None:
    while True:
        try:
            if not _reap_dead_running_jobs():
                _launch_next()
        except Exception as error:  # keep the runner alive
            print(f"Job runner error: {error}", flush=True)
        time.sleep(1.0)


def start_runner() -> None:
    global _runner_started
    if _runner_started:
        return
    _runner_started = True
    threading.Thread(target=_runner_loop, name="job-runner", daemon=True).start()


class JobContext:
    """Handed to job functions: progress reporting and cancellation checks."""

    def __init__(self, job_id: str | None) -> None:
        self.job_id = job_id
        self._last_write = 0.0

    def progress(self, fraction: float, message: str | None = None, force: bool = False) -> None:
        fraction = max(0.0, min(1.0, fraction))
        if message:
            print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)
        if self.job_id is None:
            return
        now = time.time()
        if not force and now - self._last_write < 0.5:
            return
        self._last_write = now
        with db.connect() as conn:
            status = conn.execute("SELECT status FROM jobs WHERE id = ?", (self.job_id,)).fetchone()
            if status and status["status"] == "cancelled":
                raise JobCancelled()
            conn.execute(
                "UPDATE jobs SET progress = ?, message = COALESCE(?, message) WHERE id = ?",
                (fraction, message, self.job_id),
            )

    def log(self, message: str) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)
