from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import jobs
from ..config import SYMBOLS, TARGET_SYMBOL
from ..data.series import coverage, load_minute_bars
from ..features.build import load_features_meta

router = APIRouter(tags=["data"])

TIMEFRAMES = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
MAX_CANDLES = 5000
_bars_cache: dict[str, tuple[float, pd.DataFrame]] = {}


class DownloadRequest(BaseModel):
    start_month: str | None = None


def _active(kind: str) -> dict[str, Any] | None:
    return next((job for job in jobs.list_jobs(100) if job["kind"] == kind and job["status"] in ("queued", "running")), None)


@router.get("/api/data/status")
def data_status():
    features = load_features_meta()
    return {
        "symbols": [coverage(symbol) for symbol in SYMBOLS],
        "features": None if features is None else {key: value for key, value in features.items() if key != "columns"} | {"feature_count": len(features["columns"])},
        "active_jobs": {kind: _active(kind) for kind in ("download", "build_series", "build_features")},
    }


@router.get("/api/data/features")
def feature_list():
    meta = load_features_meta()
    if meta is None:
        raise HTTPException(404, "Features not built yet")
    return meta


@router.post("/api/data/download")
def start_download(request: DownloadRequest):
    existing = _active("download")
    if existing:
        return existing
    return jobs.create_job("download", request.model_dump(exclude_none=True))


@router.post("/api/data/build")
def start_build():
    existing = _active("build_series")
    if existing:
        return existing
    return jobs.create_job("build_series", {})


@router.post("/api/data/features")
def start_features():
    existing = _active("build_features")
    if existing:
        return existing
    return jobs.create_job("build_features", {})


def _bars(symbol: str) -> pd.DataFrame:
    from ..data.series import bars_path

    mtime = bars_path(symbol).stat().st_mtime
    cached = _bars_cache.get(symbol)
    if cached and cached[0] == mtime:
        return cached[1]
    frame = load_minute_bars(symbol)[["ts", "open", "high", "low", "close", "volume"]]
    _bars_cache[symbol] = (mtime, frame)
    return frame


@router.get("/api/market/candles")
def candles(symbol: str = TARGET_SYMBOL, tf: str = "1h", start: int | None = None, end: int | None = None):
    if symbol not in SYMBOLS:
        raise HTTPException(400, f"symbol must be one of {SYMBOLS}")
    if tf not in TIMEFRAMES:
        raise HTTPException(400, f"tf must be one of {list(TIMEFRAMES)}")
    try:
        bars = _bars(symbol)
    except FileNotFoundError:
        raise HTTPException(404, "1m bars not built yet")
    seconds = TIMEFRAMES[tf]
    if start is not None:
        bars = bars[bars["ts"] >= start]
    if end is not None:
        bars = bars[bars["ts"] < end]
    if bars.empty:
        return {"symbol": symbol, "tf": tf, "candles": []}
    group = (bars["ts"].to_numpy() // seconds) * seconds
    grouped = bars.groupby(group)
    frame = pd.DataFrame(
        {
            "t": grouped["ts"].first() // seconds * seconds,
            "o": grouped["open"].first(),
            "h": grouped["high"].max(),
            "l": grouped["low"].min(),
            "c": grouped["close"].last(),
            "v": grouped["volume"].sum(),
        }
    ).tail(MAX_CANDLES)
    frame = frame.replace({np.nan: None})
    return {"symbol": symbol, "tf": tf, "candles": frame.to_dict(orient="records")}
