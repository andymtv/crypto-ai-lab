from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import jobs
from ..models import train

router = APIRouter(prefix="/api/models", tags=["models"])


class LabelConfig(BaseModel):
    tp_pct: float = Field(0.6, gt=0, le=20)
    sl_pct: float = Field(0.4, gt=0, le=20)
    horizon_minutes: int = Field(60, ge=1, le=1440)
    latency_seconds: int = Field(1, ge=0, le=60)


class WalkForward(BaseModel):
    train_months: int = Field(24, ge=3, le=72)
    test_months: int = Field(3, ge=1, le=12)
    min_train_months: int = Field(12, ge=3, le=48)
    window: str = Field("rolling", pattern="^(rolling|expanding)$")


class LgbmParams(BaseModel):
    num_leaves: int = Field(31, ge=4, le=255)
    learning_rate: float = Field(0.03, gt=0, le=0.5)
    min_data_in_leaf: int = Field(400, ge=10, le=100000)
    feature_fraction: float = Field(0.7, gt=0, le=1)
    max_rounds: int = Field(2000, ge=10, le=10000)


class TrainRequest(BaseModel):
    name: str | None = None
    model_type: str = Field("lgbm", pattern="^(lgbm|logreg)$")
    label: LabelConfig = LabelConfig()
    walk_forward: WalkForward = WalkForward()
    train_stride_minutes: int = Field(5, ge=1, le=60)
    target_symbol: str = "SOLUSDT"
    # None = no context coin.
    context_symbol: str | None = "BTCUSDT"
    fee_pct: float = Field(0.1, ge=0, le=1)
    lgbm: LgbmParams = LgbmParams()


def _with_job(run: dict[str, Any]) -> dict[str, Any]:
    run["job"] = jobs.get_job(run["job_id"]) if run.get("job_id") else None
    return run


@router.get("")
def list_runs(target: str | None = None):
    runs = train.list_model_runs()
    if target:
        runs = [run for run in runs if run["params"].get("target_symbol") == target.upper()]
    return [_with_job(run) for run in runs]


@router.post("")
def create_run(request: TrainRequest):
    try:
        run = train.create_model_run(request.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error))
    job = jobs.create_job("train", {"run_id": run["id"]})
    train.attach_job(run["id"], job["id"])
    return _with_job(train.get_model_run(run["id"]))


@router.get("/{run_id}")
def get_run(run_id: str):
    run = train.get_model_run(run_id)
    if run is None:
        raise HTTPException(404, "Model run not found")
    run = _with_job(run)
    for name in ("folds", "importance", "calibration", "histogram", "thresholds"):
        run[name] = train.read_run_file(run_id, f"{name}.json")
    return run


@router.get("/{run_id}/predictions")
def predictions(run_id: str, start: int | None = None, end: int | None = None, bucket_minutes: int = 60):
    """OOF probabilities averaged per bucket (for charts)."""
    try:
        oof = train.load_oof(run_id)
    except FileNotFoundError:
        raise HTTPException(404, "No predictions for this run")
    if start is not None:
        oof = oof[oof["ts"] >= start]
    if end is not None:
        oof = oof[oof["ts"] < end]
    bucket = max(1, bucket_minutes) * 60
    grouped = oof.groupby(oof["ts"] // bucket * bucket)
    frame = grouped.agg(prob=("prob", "mean"), prob_max=("prob", "max"), hit_rate=("label", "mean")).reset_index()
    frame = frame.rename(columns={"ts": "t"}).tail(20000).replace({np.nan: None})
    return {"points": frame.to_dict(orient="records")}


@router.delete("/{run_id}")
def delete_run(run_id: str):
    run = train.get_model_run(run_id)
    if run is None:
        raise HTTPException(404, "Model run not found")
    if run.get("job_id"):
        jobs.cancel_job(run["job_id"])
    train.delete_model_run(run_id)
    return {"deleted": run_id}
