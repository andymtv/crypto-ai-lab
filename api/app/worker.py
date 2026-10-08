"""Entry point of a job worker process: `python -m app.worker <job_id>`."""

from __future__ import annotations

import json
import sys
import traceback

from . import db
from .jobs import JobCancelled, JobContext, get_job


def run_job(kind: str, params: dict, ctx: JobContext):
    if kind == "download":
        from .data.binance_vision import download_history

        return download_history(params, ctx)
    if kind == "build_series":
        from .data.series import build_series

        return build_series(params, ctx)
    if kind == "build_features":
        from .features.build import build_features

        return build_features(params, ctx)
    if kind == "train":
        from .models.train import train_model_run

        return train_model_run(params, ctx)
    if kind == "backtest":
        from .backtest.runner import run_backtest_job

        return run_backtest_job(params, ctx)
    raise ValueError(f"Unknown job kind: {kind}")


def main(job_id: str) -> int:
    job = get_job(job_id)
    if job is None:
        print(f"Job {job_id} not found", flush=True)
        return 1

    ctx = JobContext(job_id)
    try:
        result = run_job(job["kind"], job["params"], ctx)
    except JobCancelled:
        print("Job cancelled.", flush=True)
        return 0
    except Exception as error:
        traceback.print_exc()
        with db.connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
                (f"{type(error).__name__}: {error}", db.now(), job_id),
            )
        return 1

    with db.connect() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'done', progress = 1, result = ?, finished_at = ? WHERE id = ? AND status = 'running'",
            (json.dumps(result) if result is not None else None, db.now(), job_id),
        )
    print("Job finished.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
