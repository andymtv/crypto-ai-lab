"""Feature matrix on the 1-minute decision grid.

Row `ts` is the 1m bar that opens at `ts`; the decision is taken when it
closes, at `ts + 60`. Every feature in a row only uses bars that have closed
by then:

- 1m features use the row's bar and earlier ones (rolling / EWM windows).
- 5m / 15m / 1h indicators are computed on closed higher-timeframe bars and
  assigned to the 1m row of the bar's last minute, then carried forward.

`tests/test_features_leakage.py` checks this by rebuilding on truncated data.

Groups:
- per coin (sol_*, btc_*): multi-window returns, 1s-based realized volatility,
  ranges, volume / trade / taker-flow statistics, Donchian and VWAP position,
  RSI / MACD / Bollinger / ATR / EMA distances / ADX on 5m, 15m and 1h bars.
- SOL candle shapes of the last five 5m bars (the model learns patterns).
- SOL vs BTC: rolling beta / correlation, BTC-minus-SOL return gaps (BTC tends
  to lead), SOL residual return after BTC beta.
- calendar: hour of day and day of week (cyclical).
"""

from __future__ import annotations

import json
import time
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..config import CONTEXT_SYMBOL, FEATURES_DIR, TARGET_SYMBOL
from ..data.series import bars_path, load_minute_bars
from . import indicators as ta

FEATURE_SET = "v1"
RETURN_WINDOWS = (1, 3, 5, 15, 30, 60, 240, 1440)
VOL_WINDOWS = (5, 15, 60, 240)
POSITION_WINDOWS = (60, 240, 1440)
HTF_MINUTES = {"5m": 5, "15m": 15, "1h": 60}
CORR_WINDOWS = (60, 240, 1440)
CANDLE_LOOKBACK = 5
FORWARD_FILL_LIMIT_MINUTES = 30


def features_path(feature_set: str = FEATURE_SET):
    return FEATURES_DIR / f"features_{feature_set}.parquet"


def features_meta_path(feature_set: str = FEATURE_SET):
    return FEATURES_DIR / f"features_{feature_set}.json"


def _f32(values: pd.Series | np.ndarray) -> np.ndarray:
    array = np.asarray(values, dtype=np.float64)
    array[~np.isfinite(array)] = np.nan
    return array.astype(np.float32)


def align_to_grid(bars: pd.DataFrame, grid: np.ndarray) -> pd.DataFrame:
    """Bars on every grid minute; gaps keep NaN OHLC and zero volume."""
    frame = bars.set_index("ts").reindex(grid)
    frame.index.name = "ts"
    frame["present"] = frame["close"].notna()
    for column in ("volume", "quote_volume", "trades"):
        frame[column] = frame[column].fillna(0)
    return frame


def higher_timeframe(frame: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """Closed higher-timeframe bars, indexed by the 1m row where they become known."""
    groups = (frame.index.to_numpy() // (minutes * 60)) * (minutes * 60)
    grouped = frame.groupby(groups)
    htf = pd.DataFrame(
        {
            "open": grouped["open"].first(),
            "high": grouped["high"].max(),
            "low": grouped["low"].min(),
            "close": grouped["close"].last(),
            "volume": grouped["volume"].sum(),
        }
    )
    htf = htf[htf["close"].notna()]
    # Known once the bar's last minute has closed.
    htf.index = htf.index + (minutes - 1) * 60
    return htf


def coin_features(frame: pd.DataFrame, prefix: str, out: dict[str, np.ndarray]) -> None:
    close = frame["close"].ffill(limit=FORWARD_FILL_LIMIT_MINUTES)
    high = frame["high"].fillna(close)
    low = frame["low"].fillna(close)
    log_close = np.log(close)

    for window in RETURN_WINDOWS:
        out[f"{prefix}_ret_{window}m"] = _f32(log_close - log_close.shift(window))

    realized_sq = frame["realized_vol"].astype(np.float64).fillna(0) ** 2
    for window in VOL_WINDOWS:
        out[f"{prefix}_rv_{window}m"] = _f32(np.sqrt(realized_sq.rolling(window, min_periods=window).sum()))
    out[f"{prefix}_rv_ratio_15_240"] = _f32(out[f"{prefix}_rv_15m"] / out[f"{prefix}_rv_240m"])
    out[f"{prefix}_max_second_move_15m"] = _f32(frame["max_second_move"].rolling(15, min_periods=1).max())

    for window in POSITION_WINDOWS:
        rolling_high = high.rolling(window, min_periods=window).max()
        rolling_low = low.rolling(window, min_periods=window).min()
        span = (rolling_high - rolling_low).replace(0, np.nan)
        out[f"{prefix}_range_{window}m"] = _f32(span / close)
        out[f"{prefix}_donchian_pos_{window}m"] = _f32((close - rolling_low) / span)
        volume_sum = frame["volume"].rolling(window, min_periods=window).sum()
        vwap = frame["quote_volume"].rolling(window, min_periods=window).sum() / volume_sum.replace(0, np.nan)
        out[f"{prefix}_vwap_dist_{window}m"] = _f32(close / vwap - 1)

    log_volume = np.log1p(frame["quote_volume"].astype(np.float64))
    for window in (60, 1440):
        mean = log_volume.rolling(window, min_periods=window).mean()
        std = log_volume.rolling(window, min_periods=window).std()
        out[f"{prefix}_volume_z_{window}m"] = _f32((log_volume - mean) / std.replace(0, np.nan))
    log_trades = np.log1p(frame["trades"].astype(np.float64))
    out[f"{prefix}_trades_z_60m"] = _f32(
        (log_trades - log_trades.rolling(60, min_periods=60).mean()) / log_trades.rolling(60, min_periods=60).std().replace(0, np.nan)
    )

    taker_volume = (frame["taker_buy_share"].astype(np.float64) * frame["volume"]).fillna(0)
    for window in (5, 15, 60):
        total = frame["volume"].rolling(window, min_periods=window).sum()
        out[f"{prefix}_taker_imbalance_{window}m"] = _f32(taker_volume.rolling(window, min_periods=window).sum() / total.replace(0, np.nan) - 0.5)

    grid_index = frame.index
    for label, minutes in HTF_MINUTES.items():
        htf = higher_timeframe(frame, minutes)
        h_close, h_high, h_low = htf["close"], htf["high"], htf["low"]
        h_atr = ta.atr(h_high, h_low, h_close, 14)
        percent_b, width = ta.bollinger(h_close)
        values = {
            "rsi14": ta.rsi(h_close, 14),
            "macd_hist_atr": ta.macd_hist(h_close) / h_atr,
            "bb_pctb": percent_b,
            "bb_width": width,
            "atr_pct": h_atr / h_close,
            "adx14": ta.adx(h_high, h_low, h_close, 14),
            "dist_ema20_atr": (h_close - ta.ema(h_close, 20)) / h_atr,
            "dist_ema50_atr": (h_close - ta.ema(h_close, 50)) / h_atr,
            "dist_ema200_atr": (h_close - ta.ema(h_close, 200)) / h_atr,
            "ema50_slope": ta.ema(h_close, 50).pct_change(5, fill_method=None),
        }
        for name, series in values.items():
            out[f"{prefix}_{label}_{name}"] = _f32(series.reindex(grid_index, method="ffill"))

        if prefix == "sol" and label == "5m":
            body_base = h_atr.replace(0, np.nan)
            top = htf[["open", "close"]].max(axis=1)
            bottom = htf[["open", "close"]].min(axis=1)
            shapes = {
                "body": (htf["close"] - htf["open"]) / body_base,
                "upper_wick": (htf["high"] - top) / body_base,
                "lower_wick": (bottom - htf["low"]) / body_base,
            }
            for lag in range(CANDLE_LOOKBACK):
                for name, series in shapes.items():
                    out[f"sol_candle{lag}_{name}"] = _f32(series.shift(lag).reindex(grid_index, method="ffill"))


def cross_features(sol: pd.DataFrame, btc: pd.DataFrame, out: dict[str, np.ndarray]) -> None:
    sol_close = np.log(sol["close"].ffill(limit=FORWARD_FILL_LIMIT_MINUTES))
    btc_close = np.log(btc["close"].ffill(limit=FORWARD_FILL_LIMIT_MINUTES))
    sol_r1 = sol_close.diff()
    btc_r1 = btc_close.diff()

    for window in CORR_WINDOWS:
        covariance = sol_r1.rolling(window, min_periods=window).cov(btc_r1)
        variance = btc_r1.rolling(window, min_periods=window).var()
        beta = covariance / variance.replace(0, np.nan)
        out[f"x_beta_{window}m"] = _f32(beta)
        out[f"x_corr_{window}m"] = _f32(sol_r1.rolling(window, min_periods=window).corr(btc_r1))

    beta_240 = pd.Series(out["x_beta_240m"], index=sol.index).astype(np.float64)
    for window in (1, 2, 3, 5, 15):
        sol_ret = sol_close - sol_close.shift(window)
        btc_ret = btc_close - btc_close.shift(window)
        # BTC moved, SOL has not caught up yet (scaled by SOL's beta).
        out[f"x_btc_lead_gap_{window}m"] = _f32(beta_240 * btc_ret - sol_ret)
    for window in (15, 60, 240):
        sol_ret = sol_close - sol_close.shift(window)
        btc_ret = btc_close - btc_close.shift(window)
        out[f"x_sol_residual_{window}m"] = _f32(sol_ret - beta_240 * btc_ret)


def calendar_features(grid: np.ndarray, out: dict[str, np.ndarray]) -> None:
    decision = grid + 60
    hour = (decision % 86400) / 3600.0
    day = ((decision // 86400) + 3) % 7  # 1970-01-01 was a Thursday -> Monday = 0
    out["cal_hour_sin"] = np.sin(2 * np.pi * hour / 24).astype(np.float32)
    out["cal_hour_cos"] = np.cos(2 * np.pi * hour / 24).astype(np.float32)
    out["cal_dow_sin"] = np.sin(2 * np.pi * day / 7).astype(np.float32)
    out["cal_dow_cos"] = np.cos(2 * np.pi * day / 7).astype(np.float32)


def compute_features(sol_bars: pd.DataFrame, btc_bars: pd.DataFrame, ctx=None) -> dict[str, np.ndarray]:
    """Feature columns (float32) plus `ts` and `valid` for the shared minute grid."""
    start = int(max(sol_bars["ts"].min(), btc_bars["ts"].min()))
    end = int(min(sol_bars["ts"].max(), btc_bars["ts"].max()))
    grid = np.arange(start, end + 1, 60, dtype=np.int64)

    sol = align_to_grid(sol_bars, grid)
    btc = align_to_grid(btc_bars, grid)
    out: dict[str, np.ndarray] = {"ts": grid, "valid": sol["present"].to_numpy()}

    if ctx:
        ctx.progress(0.1, "Computing SOL features")
    coin_features(sol, "sol", out)
    if ctx:
        ctx.progress(0.45, "Computing BTC features")
    coin_features(btc, "btc", out)
    if ctx:
        ctx.progress(0.8, "Computing SOL/BTC cross features")
    cross_features(sol, btc, out)
    calendar_features(grid, out)
    return out


def feature_columns(columns: list[str]) -> list[str]:
    return [column for column in columns if column not in ("ts", "valid")]


def build_features(params: dict[str, Any] | None, ctx) -> dict[str, Any]:
    started = time.time()
    ctx.progress(0.02, "Loading 1m bars", force=True)
    sol_bars = load_minute_bars(TARGET_SYMBOL)
    btc_bars = load_minute_bars(CONTEXT_SYMBOL)
    out = compute_features(sol_bars, btc_bars, ctx)
    del sol_bars, btc_bars

    ctx.progress(0.9, "Writing feature matrix", force=True)
    FEATURES_DIR.mkdir(parents=True, exist_ok=True)
    table = pa.table(out)
    path = features_path()
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd", row_group_size=1 << 18)
    tmp.replace(path)

    meta = {
        "feature_set": FEATURE_SET,
        "rows": int(len(out["ts"])),
        "columns": feature_columns(list(out.keys())),
        "first_ts": int(out["ts"][0]),
        "last_ts": int(out["ts"][-1]),
        "built_at": time.time(),
        "build_seconds": round(time.time() - started, 1),
        "source_bars_mtime": max(bars_path(TARGET_SYMBOL).stat().st_mtime, bars_path(CONTEXT_SYMBOL).stat().st_mtime),
    }
    features_meta_path().write_text(json.dumps(meta, indent=1))
    return {key: value for key, value in meta.items() if key != "columns"} | {"feature_count": len(meta["columns"])}


def load_features_meta() -> dict[str, Any] | None:
    path = features_meta_path()
    return json.loads(path.read_text()) if path.exists() else None


def features_are_current() -> bool:
    meta = load_features_meta()
    if meta is None or not features_path().exists():
        return False
    try:
        latest_bars = max(bars_path(TARGET_SYMBOL).stat().st_mtime, bars_path(CONTEXT_SYMBOL).stat().st_mtime)
    except FileNotFoundError:
        return True
    return meta.get("source_bars_mtime", 0) >= latest_bars


def load_features(columns: list[str] | None = None, start_ts: int | None = None, end_ts: int | None = None) -> pd.DataFrame:
    """Feature rows in [start_ts, end_ts), only the requested columns (plus ts, valid)."""
    wanted = None if columns is None else ["ts", "valid", *columns]
    filters = []
    if start_ts is not None:
        filters.append(("ts", ">=", int(start_ts)))
    if end_ts is not None:
        filters.append(("ts", "<", int(end_ts)))
    table = pq.read_table(features_path(), columns=wanted, filters=filters or None)
    return table.to_pandas()
