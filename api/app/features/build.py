"""Feature matrix on the 1-minute decision grid.

Row `ts` is the 1m bar that opens at `ts`; the decision is taken when it
closes, at `ts + 60`. Every feature in a row only uses bars that have closed
by then:

- 1m features use the row's bar and earlier ones (rolling / EWM windows).
- 5m / 15m / 1h indicators are computed on closed higher-timeframe bars and
  assigned to the 1m row of the bar's last minute, then carried forward.

`tests/test_features_leakage.py` checks this by rebuilding on truncated data.

Groups:
- per coin (target_* for the traded coin, ctx_* for the context coin, e.g.
  BTC): multi-window returns, 1s-based realized volatility,
  ranges, volume / trade / taker-flow statistics, Donchian and VWAP position,
  RSI / MACD / Bollinger / ATR / EMA distances / ADX on 5m, 15m and 1h bars.
- target candle shapes of the last five 5m bars (the model learns patterns).
- target vs context (x_*): rolling beta / correlation, context-lead gaps (BTC
  tends to lead alts), the target's residual return after the context beta.
  Without a context coin these groups are simply absent.
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

from ..config import FEATURES_DIR
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


def feature_key(target: str, context: str | None) -> str:
    return f"{target}__{context or 'none'}__{FEATURE_SET}"


def features_path(target: str, context: str | None):
    return FEATURES_DIR / f"features_{feature_key(target, context)}.parquet"


def features_meta_path(target: str, context: str | None):
    return FEATURES_DIR / f"features_{feature_key(target, context)}.json"


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


def coin_features(frame: pd.DataFrame, prefix: str, out: dict[str, np.ndarray], candles: bool = False) -> None:
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

        if candles and label == "5m":
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
                    out[f"{prefix}_candle{lag}_{name}"] = _f32(series.shift(lag).reindex(grid_index, method="ffill"))


def cross_features(target: pd.DataFrame, context: pd.DataFrame, out: dict[str, np.ndarray]) -> None:
    target_close = np.log(target["close"].ffill(limit=FORWARD_FILL_LIMIT_MINUTES))
    context_close = np.log(context["close"].ffill(limit=FORWARD_FILL_LIMIT_MINUTES))
    target_r1 = target_close.diff()
    context_r1 = context_close.diff()

    for window in CORR_WINDOWS:
        covariance = target_r1.rolling(window, min_periods=window).cov(context_r1)
        variance = context_r1.rolling(window, min_periods=window).var()
        beta = covariance / variance.replace(0, np.nan)
        out[f"x_beta_{window}m"] = _f32(beta)
        out[f"x_corr_{window}m"] = _f32(target_r1.rolling(window, min_periods=window).corr(context_r1))

    beta_240 = pd.Series(out["x_beta_240m"], index=target.index).astype(np.float64)
    for window in (1, 2, 3, 5, 15):
        target_ret = target_close - target_close.shift(window)
        context_ret = context_close - context_close.shift(window)
        # The context coin moved, the target has not caught up yet (scaled by beta).
        out[f"x_ctx_lead_gap_{window}m"] = _f32(beta_240 * context_ret - target_ret)
    for window in (15, 60, 240):
        target_ret = target_close - target_close.shift(window)
        context_ret = context_close - context_close.shift(window)
        out[f"x_target_residual_{window}m"] = _f32(target_ret - beta_240 * context_ret)


def calendar_features(grid: np.ndarray, out: dict[str, np.ndarray]) -> None:
    decision = grid + 60
    hour = (decision % 86400) / 3600.0
    day = ((decision // 86400) + 3) % 7  # 1970-01-01 was a Thursday -> Monday = 0
    out["cal_hour_sin"] = np.sin(2 * np.pi * hour / 24).astype(np.float32)
    out["cal_hour_cos"] = np.cos(2 * np.pi * hour / 24).astype(np.float32)
    out["cal_dow_sin"] = np.sin(2 * np.pi * day / 7).astype(np.float32)
    out["cal_dow_cos"] = np.cos(2 * np.pi * day / 7).astype(np.float32)


def compute_features(target_bars: pd.DataFrame, context_bars: pd.DataFrame | None, ctx=None) -> dict[str, np.ndarray]:
    """Feature columns (float32) plus `ts` and `valid` on the minute grid.

    With a context coin the grid is the range both coins cover.
    """
    start = int(target_bars["ts"].min())
    end = int(target_bars["ts"].max())
    if context_bars is not None:
        start = max(start, int(context_bars["ts"].min()))
        end = min(end, int(context_bars["ts"].max()))
    grid = np.arange(start, end + 1, 60, dtype=np.int64)

    target = align_to_grid(target_bars, grid)
    out: dict[str, np.ndarray] = {"ts": grid, "valid": target["present"].to_numpy()}

    if ctx:
        ctx.progress(0.1, "Computing target-coin features")
    coin_features(target, "target", out, candles=True)
    if context_bars is not None:
        context = align_to_grid(context_bars, grid)
        if ctx:
            ctx.progress(0.45, "Computing context-coin features")
        coin_features(context, "ctx", out)
        if ctx:
            ctx.progress(0.8, "Computing cross features")
        cross_features(target, context, out)
    calendar_features(grid, out)
    return out


def feature_columns(columns: list[str]) -> list[str]:
    return [column for column in columns if column not in ("ts", "valid")]


def build_features(params: dict[str, Any], ctx) -> dict[str, Any]:
    target = params["target"]
    context = params.get("context") or None
    started = time.time()
    ctx.progress(0.02, f"Loading 1m bars for {target}{' + ' + context if context else ''}", force=True)
    target_bars = load_minute_bars(target)
    context_bars = load_minute_bars(context) if context else None
    out = compute_features(target_bars, context_bars, ctx)
    del target_bars, context_bars

    ctx.progress(0.9, "Writing feature matrix", force=True)
    FEATURES_DIR.mkdir(parents=True, exist_ok=True)
    path = features_path(target, context)
    tmp = path.with_suffix(".tmp")
    pq.write_table(pa.table(out), tmp, compression="zstd", row_group_size=1 << 18)
    tmp.replace(path)

    meta = {
        "target": target,
        "context": context,
        "feature_set": FEATURE_SET,
        "rows": int(len(out["ts"])),
        "columns": feature_columns(list(out.keys())),
        "first_ts": int(out["ts"][0]),
        "last_ts": int(out["ts"][-1]),
        "built_at": time.time(),
        "build_seconds": round(time.time() - started, 1),
        "source_bars_mtime": _source_mtime(target, context),
    }
    features_meta_path(target, context).write_text(json.dumps(meta, indent=1))
    return {key: value for key, value in meta.items() if key != "columns"} | {"feature_count": len(meta["columns"])}


def _source_mtime(target: str, context: str | None) -> float:
    paths = [bars_path(target)] + ([bars_path(context)] if context else [])
    return max(path.stat().st_mtime for path in paths)


def load_features_meta(target: str, context: str | None) -> dict[str, Any] | None:
    path = features_meta_path(target, context)
    return json.loads(path.read_text()) if path.exists() else None


def list_feature_sets() -> list[dict[str, Any]]:
    metas = []
    for path in sorted(FEATURES_DIR.glob("features_*.json")):
        meta = json.loads(path.read_text())
        if "target" not in meta:
            continue  # pre-multi-coin leftover
        metas.append({key: value for key, value in meta.items() if key != "columns"} | {"feature_count": len(meta["columns"])})
    return metas


def features_are_current(target: str, context: str | None) -> bool:
    meta = load_features_meta(target, context)
    if meta is None or not features_path(target, context).exists():
        return False
    try:
        latest_bars = _source_mtime(target, context)
    except FileNotFoundError:
        return True
    return meta.get("source_bars_mtime", 0) >= latest_bars


def load_features(
    target: str,
    context: str | None,
    columns: list[str] | None = None,
    start_ts: int | None = None,
    end_ts: int | None = None,
) -> pd.DataFrame:
    """Feature rows in [start_ts, end_ts), only the requested columns (plus ts, valid)."""
    wanted = None if columns is None else ["ts", "valid", *columns]
    filters = []
    if start_ts is not None:
        filters.append(("ts", ">=", int(start_ts)))
    if end_ts is not None:
        filters.append(("ts", "<", int(end_ts)))
    table = pq.read_table(features_path(target, context), columns=wanted, filters=filters or None)
    return table.to_pandas()
