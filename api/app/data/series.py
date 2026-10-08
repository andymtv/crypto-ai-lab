"""Dense per-second series and 1-minute bars.

The downloaded Parquet months are unpacked into one memory-mapped array per
field and symbol, indexed by `second - t0` (t0 = the symbol's first processed month). Any second can be read in
O(1) without loading the history into RAM (190M+ seconds per symbol), which
is what labels and backtest fills need. Missing seconds have NaN prices and
`trades = -1`.

From the dense series we also derive 1-minute bars with microstructure stats
(realized volatility of 1s returns, taker buy share, trade count, gaps), the
grid the models decide on.
"""

from __future__ import annotations

import json
import os
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..config import DEFAULT_SYMBOLS, HISTORY_START_MONTH, SERIES_DIR
from .symbols import local_symbols, normalize_symbol
from .binance_vision import available_months, daily_dir, month_path, read_month

PRICE_FIELDS = ("open", "high", "low", "close")
FLOAT_FIELDS = ("volume", "quote_volume", "taker_buy_base")
FIELD_DTYPES: dict[str, Any] = {
    **{field: np.float64 for field in PRICE_FIELDS},
    **{field: np.float32 for field in FLOAT_FIELDS},
    "trades": np.int32,
}
FILL_VALUES = {**{field: np.nan for field in PRICE_FIELDS}, **{field: 0.0 for field in FLOAT_FIELDS}, "trades": -1}


def series_dir(symbol: str) -> Path:
    return SERIES_DIR / symbol


def meta_path(symbol: str) -> Path:
    return series_dir(symbol) / "meta.json"


def bars_path(symbol: str) -> Path:
    return series_dir(symbol) / "bars_1m.parquet"


def first_month(symbol: str) -> str | None:
    """First month to process: the later of LAB_HISTORY_START and the first downloaded month."""
    months = available_months(symbol)
    if not months:
        return None
    return max(months[0], HISTORY_START_MONTH)


def series_t0(symbol: str) -> int:
    month = first_month(symbol) or HISTORY_START_MONTH
    return int(pd.Timestamp(year=int(month[:4]), month=int(month[5:7]), day=1, tz="UTC").timestamp())


def load_meta(symbol: str) -> dict[str, Any]:
    path = meta_path(symbol)
    t0 = series_t0(symbol)
    if not path.exists():
        return {"t0": t0, "length": 0, "months": {}}
    meta = json.loads(path.read_text())
    if meta.get("t0") != t0:
        # LAB_HISTORY_START changed: the dense files start elsewhere; rebuild.
        for field in FIELD_DTYPES:
            _field_path(symbol, field).unlink(missing_ok=True)
        return {"t0": t0, "length": 0, "months": {}}
    return meta


def save_meta(symbol: str, meta: dict[str, Any]) -> None:
    path = meta_path(symbol)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=1))
    tmp.replace(path)


def _field_path(symbol: str, field: str) -> Path:
    return series_dir(symbol) / f"{field}.bin"


def _extend(symbol: str, field: str, old_length: int, new_length: int) -> None:
    """Grows a field file to new_length, filling the new tail with the missing value."""
    path = _field_path(symbol, field)
    dtype = np.dtype(FIELD_DTYPES[field])
    with open(path, "ab") as handle:
        remaining = new_length - old_length
        chunk = np.full(min(remaining, 1 << 22), FILL_VALUES[field], dtype=dtype)
        while remaining > 0:
            count = min(remaining, len(chunk))
            handle.write(chunk[:count].tobytes())
            remaining -= count


def _source_signature(symbol: str, month: str) -> str:
    path = month_path(symbol, month)
    if path.exists():
        return f"monthly:{path.stat().st_mtime_ns}"
    days = sorted(daily_dir(symbol, month).glob("*.parquet"))
    return f"daily:{len(days)}:{days[-1].stat().st_mtime_ns if days else 0}"


@dataclass
class Series:
    """Read-only view of one symbol's dense per-second series."""

    symbol: str
    t0: int
    length: int
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    quote_volume: np.ndarray
    taker_buy_base: np.ndarray
    trades: np.ndarray

    @property
    def end_ts(self) -> int:
        return self.t0 + self.length

    def index(self, ts: int | np.ndarray) -> int | np.ndarray:
        return ts - self.t0


def open_series(symbol: str) -> Series:
    meta = load_meta(symbol)
    length = int(meta["length"])
    if length <= 0:
        raise FileNotFoundError(f"No series built for {symbol}. Run the dataset build first.")
    arrays = {
        field: np.memmap(_field_path(symbol, field), dtype=FIELD_DTYPES[field], mode="r", shape=(length,))
        for field in FIELD_DTYPES
    }
    return Series(symbol=symbol, t0=int(meta["t0"]), length=length, **arrays)


def build_symbol_series(symbol: str, ctx, progress_base: float, progress_span: float) -> dict[str, Any]:
    folder = series_dir(symbol)
    folder.mkdir(parents=True, exist_ok=True)
    meta = load_meta(symbol)
    start_month = first_month(symbol)
    months = [month for month in available_months(symbol) if start_month and month >= start_month]
    built = 0

    for position, month in enumerate(months):
        signature = _source_signature(symbol, month)
        if meta["months"].get(month, {}).get("signature") == signature:
            continue
        frame = read_month(symbol, month)
        if frame is None or frame.empty:
            continue

        index = frame["ts"].to_numpy() - meta["t0"]
        frame = frame[index >= 0]
        index = index[index >= 0]
        new_length = int(index.max()) + 1
        if new_length > meta["length"]:
            for field in FIELD_DTYPES:
                _extend(symbol, field, meta["length"], new_length)
            meta["length"] = new_length

        for field, dtype in FIELD_DTYPES.items():
            target = np.memmap(_field_path(symbol, field), dtype=dtype, mode="r+", shape=(meta["length"],))
            target[index] = frame[field].to_numpy(dtype=dtype)
            target.flush()
            del target

        year, mon = map(int, month.split("-"))
        month_start = int(pd.Timestamp(year=year, month=mon, day=1, tz="UTC").timestamp())
        month_end = int((pd.Timestamp(year=year, month=mon, day=1, tz="UTC") + pd.offsets.MonthBegin(1)).timestamp())
        covered_end = min(month_end, int(frame["ts"].max()) + 1)
        expected = covered_end - max(month_start, int(frame["ts"].min()))
        steps = np.diff(frame["ts"].to_numpy())
        meta["months"][month] = {
            "signature": signature,
            "rows": int(len(frame)),
            "first_ts": int(frame["ts"].min()),
            "last_ts": int(frame["ts"].max()),
            "missing_seconds": int(max(0, expected - len(frame))),
            "largest_gap_seconds": int(steps.max() - 1) if len(steps) else 0,
            "partial": not month_path(symbol, month).exists(),
        }
        save_meta(symbol, meta)
        built += 1
        ctx.progress(
            progress_base + progress_span * (position + 1) / max(1, len(months)),
            f"{symbol} {month}: {len(frame):,} seconds unpacked",
        )

    return {"months_built": built, "length": meta["length"]}


def _last_valid(values: np.ndarray) -> np.ndarray:
    """Last non-NaN value of each row (NaN if the row has none)."""
    valid = ~np.isnan(values)
    last = values.shape[1] - 1 - np.argmax(valid[:, ::-1], axis=1)
    out = values[np.arange(len(values)), last]
    out[~valid.any(axis=1)] = np.nan
    return out


def _first_valid(values: np.ndarray) -> np.ndarray:
    valid = ~np.isnan(values)
    first = np.argmax(valid, axis=1)
    out = values[np.arange(len(values)), first]
    out[~valid.any(axis=1)] = np.nan
    return out


def minute_bars_from_seconds(series: Series, start: int, stop: int) -> pd.DataFrame:
    """1-minute bars for series indexes [start, stop), both multiples of 60."""
    count = (stop - start) // 60
    shape = (count, 60)
    open_ = np.asarray(series.open[start:stop]).reshape(shape)
    high = np.asarray(series.high[start:stop]).reshape(shape)
    low = np.asarray(series.low[start:stop]).reshape(shape)
    close = np.asarray(series.close[start:stop]).reshape(shape)
    volume = np.asarray(series.volume[start:stop]).reshape(shape)
    quote_volume = np.asarray(series.quote_volume[start:stop]).reshape(shape)
    taker = np.asarray(series.taker_buy_base[start:stop]).reshape(shape)
    trades = np.asarray(series.trades[start:stop]).reshape(shape)

    present = trades >= 0
    # Fully missing minutes legitimately produce NaN bars.
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        bar_high = np.nanmax(high, axis=1)
        bar_low = np.nanmin(low, axis=1)
        log_close = np.log(close)
        second_returns = np.diff(log_close, axis=1)
        realized_vol = np.sqrt(np.nansum(second_returns**2, axis=1))
        max_second_move = np.nanmax(np.abs(second_returns), axis=1)
        total_volume = volume.sum(axis=1, dtype=np.float64)
        taker_share = np.where(total_volume > 0, taker.sum(axis=1, dtype=np.float64) / total_volume, np.nan)

    return pd.DataFrame(
        {
            "ts": series.t0 + start + np.arange(count, dtype=np.int64) * 60,
            "open": _first_valid(open_),
            "high": bar_high,
            "low": bar_low,
            "close": _last_valid(close),
            "volume": total_volume.astype(np.float32),
            "quote_volume": quote_volume.sum(axis=1, dtype=np.float64).astype(np.float32),
            "trades": np.where(present, trades, 0).sum(axis=1).astype(np.int32),
            "taker_buy_share": taker_share.astype(np.float32),
            "realized_vol": realized_vol.astype(np.float32),
            "max_second_move": max_second_move.astype(np.float32),
            "missing_seconds": (~present).sum(axis=1).astype(np.int16),
        }
    )


def build_minute_bars(symbol: str, ctx, progress_base: float, progress_span: float) -> int:
    series = open_series(symbol)
    usable = (series.length // 60) * 60
    first = 0
    chunk = 60 * 60 * 24 * 30  # ~a month of seconds per pass
    path = bars_path(symbol)
    tmp = path.with_suffix(".tmp")
    writer = None
    rows = 0
    try:
        for start in range(first, usable, chunk):
            stop = min(start + chunk, usable)
            bars = minute_bars_from_seconds(series, start, stop)
            bars = bars[bars["missing_seconds"] < 60].reset_index(drop=True)
            table = pa.Table.from_pandas(bars, preserve_index=False)
            if writer is None:
                writer = pq.ParquetWriter(tmp, table.schema, compression="zstd")
            writer.write_table(table)
            rows += len(bars)
            ctx.progress(progress_base + progress_span * (stop - first) / max(1, usable - first), f"{symbol}: 1m bars up to {pd.Timestamp(series.t0 + stop, unit='s')}")
    finally:
        if writer is not None:
            writer.close()
    tmp.replace(path)
    return rows


def build_series(params: dict[str, Any], ctx) -> dict[str, Any]:
    symbols = [normalize_symbol(symbol) for symbol in (params.get("symbols") or local_symbols() or DEFAULT_SYMBOLS)]
    result: dict[str, Any] = {}
    span = 1.0 / len(symbols)
    for position, symbol in enumerate(symbols):
        base = position * span
        series_result = build_symbol_series(symbol, ctx, base, span * 0.6)
        series_result["minute_bars"] = build_minute_bars(symbol, ctx, base + span * 0.6, span * 0.4)
        result[symbol] = series_result
    return result


def load_minute_bars(symbol: str) -> pd.DataFrame:
    path = bars_path(symbol)
    if not path.exists():
        raise FileNotFoundError(f"No 1m bars for {symbol}. Run the dataset build first.")
    return pq.read_table(path).to_pandas()


def coverage(symbol: str) -> dict[str, Any]:
    meta = load_meta(symbol)
    months = [
        {"month": month, **{key: value for key, value in info.items() if key != "signature"}}
        for month, info in sorted(meta["months"].items())
    ]
    downloaded = available_months(symbol)
    return {
        "symbol": symbol,
        "downloaded_months": downloaded,
        "built_months": [month["month"] for month in months],
        "months": months,
        "length_seconds": meta["length"],
        "first_ts": months[0]["first_ts"] if months else None,
        "last_ts": months[-1]["last_ts"] if months else None,
        "missing_seconds": sum(month["missing_seconds"] for month in months),
        "bars_built": bars_path(symbol).exists(),
        "bars_updated_at": os.path.getmtime(bars_path(symbol)) if bars_path(symbol).exists() else None,
    }
