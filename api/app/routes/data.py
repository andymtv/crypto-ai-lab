from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import jobs
from ..config import DEFAULT_SYMBOLS, DEFAULT_TARGET
from ..data.symbols import local_symbols, normalize_symbol, symbol_info
from ..data.series import coverage, load_minute_bars
from ..features.build import list_feature_sets, load_features_meta

router = APIRouter(tags=["data"])

TIMEFRAMES = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
MAX_CANDLES = 5000
_bars_cache: dict[str, tuple[float, pd.DataFrame]] = {}


class DownloadRequest(BaseModel):
    symbols: list[str] | None = None
    start_month: str | None = Field(None, pattern=r"^\d{4}-\d{2}$")


class BuildRequest(BaseModel):
    symbols: list[str] | None = None


class FeaturesRequest(BaseModel):
    target: str = DEFAULT_TARGET
    context: str | None = "BTCUSDT"


def _symbols(values: list[str] | None) -> list[str] | None:
    if not values:
        return None
    try:
        return [normalize_symbol(value) for value in values]
    except ValueError as error:
        raise HTTPException(400, str(error))


def _active(kind: str) -> dict[str, Any] | None:
    return next((job for job in jobs.list_jobs(100) if job["kind"] == kind and job["status"] in ("queued", "running")), None)


@router.get("/api/data/status")
def data_status():
    symbols = sorted(set(local_symbols()) | set(DEFAULT_SYMBOLS))
    return {
        "symbols": [coverage(symbol) for symbol in symbols],
        "features": list_feature_sets(),
        "active_jobs": {kind: _active(kind) for kind in ("download", "build_series", "build_features")},
    }


@router.get("/api/data/symbols/validate")
def validate_symbol(symbol: str):
    try:
        return symbol_info(symbol)
    except ValueError as error:
        raise HTTPException(400, str(error))


@router.get("/api/data/features")
def feature_list(target: str = DEFAULT_TARGET, context: str | None = None):
    """`context` missing, empty or "none" = the feature set without a context coin."""
    context = context.upper() if context and context.lower() != "none" else None
    meta = load_features_meta(target.upper(), context)
    if meta is None:
        raise HTTPException(404, "Features not built yet")
    return meta


@router.post("/api/data/download")
def start_download(request: DownloadRequest):
    existing = _active("download")
    if existing:
        raise HTTPException(409, "A download is already running; wait for it to finish.")
    for symbol in request.symbols or []:
        if not symbol_info(normalize_symbol(symbol))["valid"]:
            raise HTTPException(400, f"Binance publishes no 1s history for {symbol}.")
    params = {"symbols": _symbols(request.symbols), "start_month": request.start_month}
    return jobs.create_job("download", {key: value for key, value in params.items() if value})


@router.post("/api/data/build")
def start_build(request: BuildRequest | None = None):
    existing = _active("build_series")
    if existing:
        raise HTTPException(409, "A build is already running; wait for it to finish.")
    symbols = _symbols(request.symbols if request else None)
    return jobs.create_job("build_series", {"symbols": symbols} if symbols else {})


@router.post("/api/data/features")
def start_features(request: FeaturesRequest):
    target = _symbols([request.target])[0]
    context = _symbols([request.context])[0] if request.context else None
    if context == target:
        raise HTTPException(400, "The context coin must differ from the traded coin.")
    return jobs.create_job("build_features", {"target": target, "context": context})


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
def candles(symbol: str = DEFAULT_TARGET, tf: str = "1h", start: int | None = None, end: int | None = None):
    symbol = symbol.upper()
    if symbol not in local_symbols():
        raise HTTPException(404, f"No data for {symbol}")
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
