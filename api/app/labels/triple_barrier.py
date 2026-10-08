"""Triple-barrier labels evaluated on the 1-second path.

For a decision at `decision_ts` (the close of a 1m bar) the long trade enters
at the open of the second `decision_ts + latency`. It is labelled 1 when the
price reaches entry * (1 + tp) before entry * (1 - sl) within the horizon,
otherwise 0 (stop hit first, or time ran out). If one second touches both
barriers we cannot tell the order, so the stop is assumed (conservative).

Besides the binary label we keep the outcome (+1 take profit, -1 stop,
0 timeout), the seconds to exit and the gross exit return, so models and
reports can talk about money and not only hit rates.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numba
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..config import FEATURES_DIR, TARGET_SYMBOL
from ..data.series import open_series

ENTRY_SEARCH_SECONDS = 10


@numba.njit(cache=True)
def first_valid_at_or_after(close: np.ndarray, index: int, max_ahead: int) -> int:
    for offset in range(max_ahead + 1):
        position = index + offset
        if position >= close.shape[0]:
            return -1
        if not np.isnan(close[position]):
            return position
    return -1


@numba.njit(cache=True)
def simulate_long_exit(
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    entry_index: int,
    entry_price: float,
    tp: float,
    sl: float,
    horizon_seconds: int,
) -> tuple[int, int, float]:
    """(outcome, exit_index, exit_price) with outcome +1 tp, -1 sl, 0 timeout, -2 no data.

    The stop fills at the stop price, or at the second's open when the price
    gapped through it. The take profit fills at its limit price.
    """
    tp_price = entry_price * (1.0 + tp)
    sl_price = entry_price * (1.0 - sl)
    last = min(entry_index + horizon_seconds, close.shape[0] - 1)
    last_valid = -1
    for position in range(entry_index, last + 1):
        if np.isnan(close[position]):
            continue
        last_valid = position
        # Same-second touch of both barriers: assume the stop came first.
        if low[position] <= sl_price:
            opening = open_[position]
            fill = opening if (position > entry_index and opening < sl_price) else sl_price
            return -1, position, fill
        if high[position] >= tp_price:
            return 1, position, tp_price
    if last_valid < 0:
        return -2, entry_index, entry_price
    return 0, last_valid, close[last_valid]


@numba.njit(cache=True)
def label_decisions(
    decision_index: np.ndarray,
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    latency: int,
    tp: float,
    sl: float,
    horizon_seconds: int,
):
    count = decision_index.shape[0]
    outcome = np.full(count, -2, dtype=np.int8)
    exit_seconds = np.zeros(count, dtype=np.int32)
    exit_return = np.full(count, np.nan, dtype=np.float32)
    for i in range(count):
        start = decision_index[i] + latency
        if start < 0 or start >= close.shape[0]:
            continue
        entry_index = first_valid_at_or_after(close, start, 10)
        if entry_index < 0 or entry_index + horizon_seconds >= close.shape[0]:
            continue
        entry_price = open_[entry_index]
        if np.isnan(entry_price):
            entry_price = close[entry_index]
        result, exit_index, exit_price = simulate_long_exit(
            open_, high, low, close, entry_index, entry_price, tp, sl, horizon_seconds
        )
        outcome[i] = result
        exit_seconds[i] = exit_index - entry_index
        if result != -2:
            exit_return[i] = exit_price / entry_price - 1.0
    return outcome, exit_seconds, exit_return


def label_key(config: dict[str, Any]) -> str:
    canonical = json.dumps({key: config[key] for key in sorted(config)}, sort_keys=True)
    return hashlib.sha1(canonical.encode()).hexdigest()[:10]


def normalize_label_config(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "tp_pct": float(config.get("tp_pct", 0.6)),
        "sl_pct": float(config.get("sl_pct", 0.4)),
        "horizon_minutes": int(config.get("horizon_minutes", 60)),
        "latency_seconds": int(config.get("latency_seconds", 1)),
    }


def labels_path(config: dict[str, Any]):
    return FEATURES_DIR / "labels" / f"labels_{label_key(config)}.parquet"


def compute_labels(decision_ts: np.ndarray, config: dict[str, Any], ctx=None) -> pd.DataFrame:
    series = open_series(TARGET_SYMBOL)
    decision_index = (decision_ts - series.t0).astype(np.int64)
    open_ = np.asarray(series.open)
    high = np.asarray(series.high)
    low = np.asarray(series.low)
    close = np.asarray(series.close)

    outcome = np.empty(len(decision_ts), dtype=np.int8)
    exit_seconds = np.empty(len(decision_ts), dtype=np.int32)
    exit_return = np.empty(len(decision_ts), dtype=np.float32)
    chunk = 200_000
    for start in range(0, len(decision_ts), chunk):
        stop = min(start + chunk, len(decision_ts))
        result = label_decisions(
            decision_index[start:stop],
            open_,
            high,
            low,
            close,
            config["latency_seconds"],
            config["tp_pct"] / 100.0,
            config["sl_pct"] / 100.0,
            config["horizon_minutes"] * 60,
        )
        outcome[start:stop], exit_seconds[start:stop], exit_return[start:stop] = result
        if ctx:
            ctx.progress(stop / len(decision_ts), f"Labels {stop:,}/{len(decision_ts):,}")

    frame = pd.DataFrame(
        {
            "decision_ts": decision_ts,
            "outcome": outcome,
            "exit_seconds": exit_seconds,
            "exit_return": exit_return,
        }
    )
    frame["label"] = np.where(frame["outcome"] == -2, np.nan, (frame["outcome"] == 1).astype(np.float32)).astype(np.float32)
    return frame


def ensure_labels(feature_ts: np.ndarray, config: dict[str, Any], ctx=None) -> pd.DataFrame:
    """Labels for every feature row (keyed by the row's bar open `ts`), cached on disk."""
    path = labels_path(config)
    if path.exists():
        cached = pq.read_table(path).to_pandas()
        if len(cached) == len(feature_ts) and cached["ts"].iloc[-1] == feature_ts[-1]:
            return cached
    frame = compute_labels(feature_ts + 60, config, ctx)
    frame.insert(0, "ts", feature_ts)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), path, compression="zstd")
    return frame
