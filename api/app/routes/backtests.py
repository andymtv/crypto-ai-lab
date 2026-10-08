from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import jobs
from ..backtest import runner

router = APIRouter(prefix="/api/backtests", tags=["backtests"])


class BacktestRequest(BaseModel):
    name: str | None = None
    model_run_id: str
    start_ts: int | None = None
    end_ts: int | None = None
    threshold: float = Field(0.6, ge=0, le=1)
    tp_pct: float | None = Field(None, gt=0, le=50)
    sl_pct: float | None = Field(None, gt=0, le=50)
    max_hold_minutes: int | None = Field(None, ge=1, le=10080)
    fee_pct: float = Field(0.1, ge=0, le=1)
    slippage_bps: float = Field(2.0, ge=0, le=100)
    latency_seconds: int | None = Field(None, ge=0, le=60)
    initial_capital: float = Field(10.0, gt=0)
    sizing: str = Field("compound", pattern="^(fixed|compound)$")
    order_quote: float = Field(10.0, gt=0)
    compound_fraction: float = Field(1.0, gt=0, le=1)
    min_notional: float = Field(5.0, ge=0)
    cooldown_minutes: int = Field(0, ge=0, le=1440)


class SweepRequest(BacktestRequest):
    thresholds: list[float] = Field(default_factory=lambda: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75])
    tp_sl_pairs: list[list[float]] | None = None


def _payload(request: BaseModel) -> dict[str, Any]:
    return request.model_dump(exclude_none=True)


def _with_job(record: dict[str, Any]) -> dict[str, Any]:
    record["job"] = jobs.get_job(record["job_id"]) if record.get("job_id") else None
    return record


def _start(payload: dict[str, Any], kind: str) -> dict[str, Any]:
    try:
        record = runner.create_backtest(payload, kind)
    except ValueError as error:
        raise HTTPException(400, str(error))
    job = jobs.create_job("backtest", {"backtest_id": record["id"]})
    runner.attach_job(record["id"], job["id"])
    return _with_job(runner.get_backtest(record["id"]))


@router.get("")
def list_all():
    return [_with_job(record) for record in runner.list_backtests()]


@router.post("")
def create(request: BacktestRequest):
    return _start(_payload(request), "single")


@router.post("/sweep")
def create_sweep(request: SweepRequest):
    return _start(_payload(request), "sweep")


@router.get("/{backtest_id}")
def get(backtest_id: str):
    record = runner.get_backtest(backtest_id)
    if record is None:
        raise HTTPException(404, "Backtest not found")
    record = _with_job(record)
    for name in ("equity", "baselines", "monthly", "sweep"):
        record[name] = runner.read_bt_file(backtest_id, f"{name}.json")
    return record


@router.get("/{backtest_id}/trades")
def trades(backtest_id: str, limit: int = 5000):
    frame = runner.load_trades(backtest_id)
    if frame is None:
        raise HTTPException(404, "No trades for this backtest")
    return {"total": int(len(frame)), "trades": frame.tail(limit).to_dict(orient="records")}


@router.delete("/{backtest_id}")
def delete(backtest_id: str):
    record = runner.get_backtest(backtest_id)
    if record is None:
        raise HTTPException(404, "Backtest not found")
    if record.get("job_id"):
        jobs.cancel_job(record["job_id"])
    runner.delete_backtest(backtest_id)
    return {"deleted": backtest_id}
