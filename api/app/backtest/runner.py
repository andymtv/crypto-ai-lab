"""Backtest jobs: single runs (with baselines) and parameter sweeps."""

from __future__ import annotations

import json
import shutil
import time
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .. import db
from ..config import BACKTESTS_DIR
from ..data.symbols import order_filters
from ..data.series import open_series
from ..models.train import get_model_run, load_oof
from .engine import EngineParams, simulate, simulate_with_gaps

RANDOM_BASELINE_RUNS = 30
MAX_EQUITY_POINTS = 3000


def normalize_params(params: dict[str, Any], model_params: dict[str, Any]) -> dict[str, Any]:
    label = model_params["label"]
    symbol = model_params.get("target_symbol", "SOLUSDT")
    qty_step, min_notional = (
        (params["qty_step"], params["min_notional"]) if "qty_step" in params and "min_notional" in params else order_filters(symbol)
    )
    return {
        "name": params.get("name") or f"Backtest {time.strftime('%Y-%m-%d %H:%M')}",
        "model_run_id": params["model_run_id"],
        "symbol": symbol,
        "start_ts": params.get("start_ts"),
        "end_ts": params.get("end_ts"),
        "threshold": float(params.get("threshold", 0.6)),
        "tp_pct": float(params.get("tp_pct", label["tp_pct"])),
        "sl_pct": float(params.get("sl_pct", label["sl_pct"])),
        "max_hold_minutes": int(params.get("max_hold_minutes", label["horizon_minutes"])),
        "fee_pct": float(params.get("fee_pct", 0.1)),
        "slippage_bps": float(params.get("slippage_bps", 2.0)),
        "latency_seconds": int(params.get("latency_seconds", label["latency_seconds"])),
        "initial_capital": float(params.get("initial_capital", 10.0)),
        "sizing": params.get("sizing", "compound"),
        "order_quote": float(params.get("order_quote", 10.0)),
        "compound_fraction": float(params.get("compound_fraction", 1.0)),
        "min_notional": float(params.get("min_notional", min_notional)),
        "qty_step": float(params.get("qty_step", qty_step)),
        "cooldown_minutes": int(params.get("cooldown_minutes", 0)),
    }


def engine_params(params: dict[str, Any], **overrides: Any) -> EngineParams:
    fields = {name: params[name] for name in EngineParams.__dataclass_fields__}
    fields.update(overrides)
    return EngineParams(**fields)


def bt_dir(backtest_id: str):
    return BACKTESTS_DIR / backtest_id


def create_backtest(params: dict[str, Any], kind: str = "single") -> dict[str, Any]:
    run = get_model_run(params["model_run_id"])
    if run is None:
        raise ValueError("Model run not found")
    if run["status"] != "done":
        raise ValueError("Model run has not finished training")
    normalized = normalize_params(params, run["params"])
    normalized["kind"] = kind
    if kind == "sweep":
        normalized["thresholds"] = [float(x) for x in params.get("thresholds") or [0.5, 0.55, 0.6, 0.65, 0.7, 0.75]]
        normalized["tp_sl_pairs"] = [
            [float(pair[0]), float(pair[1])] for pair in (params.get("tp_sl_pairs") or [[normalized["tp_pct"], normalized["sl_pct"]]])
        ]
    backtest_id = db.new_id()
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO backtests (id, name, model_run_id, status, params, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
            (backtest_id, normalized["name"], normalized["model_run_id"], json.dumps(normalized), db.now()),
        )
    return get_backtest(backtest_id)  # type: ignore[return-value]


def attach_job(backtest_id: str, job_id: str) -> None:
    with db.connect() as conn:
        conn.execute("UPDATE backtests SET job_id = ? WHERE id = ?", (job_id, backtest_id))


def get_backtest(backtest_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM backtests WHERE id = ?", (backtest_id,)).fetchone()
    return db.row_to_dict(row, ("params", "summary"))


def list_backtests() -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM backtests ORDER BY created_at DESC").fetchall()
    return [db.row_to_dict(row, ("params", "summary")) for row in rows]  # type: ignore[misc]


def delete_backtest(backtest_id: str) -> bool:
    with db.connect() as conn:
        deleted = conn.execute("DELETE FROM backtests WHERE id = ?", (backtest_id,)).rowcount
    shutil.rmtree(bt_dir(backtest_id), ignore_errors=True)
    return deleted > 0


def read_bt_file(backtest_id: str, name: str) -> Any:
    path = bt_dir(backtest_id) / name
    return json.loads(path.read_text()) if path.exists() else None


def load_trades(backtest_id: str) -> pd.DataFrame | None:
    path = bt_dir(backtest_id) / "trades.parquet"
    return pq.read_table(path).to_pandas() if path.exists() else None


def _set(backtest_id: str, status: str, summary: dict[str, Any] | None = None) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE backtests SET status = ?, summary = COALESCE(?, summary) WHERE id = ?",
            (status, json.dumps(summary) if summary is not None else None, backtest_id),
        )


def daily_equity(result: dict, start_ts: int, end_ts: int, initial: float) -> pd.Series:
    days = pd.date_range(pd.Timestamp(start_ts, unit="s").normalize(), pd.Timestamp(end_ts, unit="s").normalize(), freq="D")
    if result["count"] == 0:
        return pd.Series(initial, index=days)
    closes = pd.Series(result["equity_after"], index=pd.to_datetime(result["exit_ts"], unit="s"))
    closes = closes.groupby(closes.index.normalize()).last()
    return closes.reindex(days).ffill().fillna(initial)


def summarize(result: dict, start_ts: int, end_ts: int, params: dict[str, Any]) -> dict[str, Any]:
    initial = params["initial_capital"]
    count = int(result["count"])
    pnl = result["pnl"]
    wins = pnl[pnl > 0]
    losses = pnl[pnl <= 0]
    final = float(result["equity_after"][-1]) if count else initial
    curve = np.concatenate([[initial], result["equity_after"]]) if count else np.array([initial])
    peaks = np.maximum.accumulate(curve)
    drawdown = float(((curve - peaks) / peaks).min()) if len(curve) > 1 else 0.0
    daily = daily_equity(result, start_ts, end_ts, initial)
    daily_returns = daily.pct_change().dropna()
    sharpe = float(daily_returns.mean() / daily_returns.std() * np.sqrt(365)) if daily_returns.std() > 0 else None
    held_seconds = (result["exit_ts"] - result["entry_ts"]).sum() if count else 0
    days = max(1e-9, (end_ts - start_ts) / 86400)
    outcomes = result["outcome"]
    return {
        "trades": count,
        "skipped_below_min_notional": int(result["skipped_small"]),
        "win_rate": float(len(wins) / count) if count else None,
        "net_pnl": float(final - initial),
        "return_pct": float((final / initial - 1) * 100),
        "final_equity": final,
        "fees_paid": float(result["fees"].sum()),
        "profit_factor": float(wins.sum() / -losses.sum()) if count and losses.sum() < 0 else None,
        "avg_win": float(wins.mean()) if len(wins) else None,
        "avg_loss": float(losses.mean()) if len(losses) else None,
        "expectancy_pct": float(np.mean(result["exit_price"] / result["entry_price"] - 1) * 100 - 2 * params["fee_pct"]) if count else None,
        "max_drawdown_pct": drawdown * 100,
        "sharpe": sharpe,
        "exposure_pct": float(held_seconds / (end_ts - start_ts) * 100) if end_ts > start_ts else 0.0,
        "avg_hold_minutes": float(held_seconds / count / 60) if count else None,
        "trades_per_day": float(count / days),
        "exits": {
            "take_profit": int((outcomes == 1).sum()),
            "stop_loss": int((outcomes == -1).sum()),
            "timeout": int((outcomes == 0).sum()),
        },
        "start_ts": int(start_ts),
        "end_ts": int(end_ts),
    }


def buy_and_hold(series, start_ts: int, end_ts: int, params: dict[str, Any]) -> dict[str, Any]:
    close = series.close
    first = int(start_ts - series.t0)
    last = int(min(end_ts, series.end_ts - 1) - series.t0)
    while first < last and np.isnan(close[first]):
        first += 1
    while last > first and np.isnan(close[last]):
        last -= 1
    entry = float(close[first])
    exit_ = float(close[last])
    fee = params["fee_pct"] / 100
    final = params["initial_capital"] * (1 - fee) * exit_ / entry * (1 - fee)
    days = pd.date_range(pd.Timestamp(start_ts, unit="s").normalize(), pd.Timestamp(end_ts, unit="s").normalize(), freq="D")
    index = np.clip(((days.astype("int64") // 10**9) - series.t0).to_numpy(), first, last)
    prices = pd.Series(np.asarray(close)[index]).ffill().to_numpy()
    curve = params["initial_capital"] * (1 - fee) * prices / entry
    peaks = np.maximum.accumulate(curve)
    return {
        "return_pct": float((final / params["initial_capital"] - 1) * 100),
        "final_equity": float(final),
        "max_drawdown_pct": float(((curve - peaks) / peaks).min() * 100),
        "curve": [{"t": int(day.timestamp()), "equity": float(value)} for day, value in zip(days, curve)],
    }


def random_baseline(result: dict, series, params: dict[str, Any], start: int, end: int, model_return: float) -> dict[str, Any]:
    """Random entry timing with the model's own trade count and waiting times.

    Each run shuffles the model's waits between one exit and the next entry
    (plus the wait before the first trade and after the last), then trades
    with the same exits, sizing and costs. Same number of trades, same time
    in and out of the market: only the timing is random, so beating these
    runs means the signal's timing carries information.
    """
    count = int(result["count"])
    if count == 0:
        return {"runs": 0}
    previous_exit = np.concatenate([[start], result["exit_ts"][:-1]])
    gaps = np.maximum(0, result["entry_ts"] - params["latency_seconds"] - previous_exit).astype(np.int64)
    returns, trades = [], []
    rng = np.random.default_rng(42)
    for _ in range(RANDOM_BASELINE_RUNS):
        shuffled = rng.permutation(gaps)
        trade_count, equity = simulate_with_gaps(shuffled, start, end, series, engine_params(params))
        returns.append(float((equity / params["initial_capital"] - 1) * 100))
        trades.append(trade_count)
    values = np.array(returns)
    return {
        "runs": RANDOM_BASELINE_RUNS,
        "mean_return_pct": float(values.mean()),
        "std_return_pct": float(values.std()),
        "p05_return_pct": float(np.percentile(values, 5)),
        "p95_return_pct": float(np.percentile(values, 95)),
        "mean_trades": float(np.mean(trades)),
        "model_percentile": float((values < model_return).mean() * 100),
        "returns": returns,
    }


def monthly_returns(daily: pd.Series) -> list[dict[str, Any]]:
    month_end = daily.groupby(daily.index.to_period("M")).last()
    previous = month_end.shift(1)
    previous.iloc[0] = daily.iloc[0]
    change = (month_end / previous - 1) * 100
    return [{"month": str(period), "return_pct": float(value)} for period, value in change.items()]


def downsample_equity(result: dict, params: dict[str, Any], start_ts: int) -> list[dict[str, float]]:
    points = [{"t": int(start_ts), "equity": params["initial_capital"]}]
    if result["count"]:
        exit_ts = result["exit_ts"]
        equity = result["equity_after"]
        step = max(1, len(exit_ts) // MAX_EQUITY_POINTS)
        selected = list(range(0, len(exit_ts), step))
        if selected[-1] != len(exit_ts) - 1:
            selected.append(len(exit_ts) - 1)
        points += [{"t": int(exit_ts[i]), "equity": float(equity[i])} for i in selected]
    return points


def _decisions(run_id: str, params: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, int, int]:
    oof = load_oof(run_id)
    start = int(params["start_ts"] or oof["ts"].iloc[0])
    end = int(params["end_ts"] or oof["ts"].iloc[-1] + 60)
    window = oof[(oof["ts"] >= start) & (oof["ts"] < end)]
    if window.empty:
        raise ValueError("No out-of-sample predictions in the selected range.")
    # Row ts is the 1m bar's open; the decision is at its close.
    return window["ts"].to_numpy() + 60, window["prob"].to_numpy(), start, end


def run_single(backtest_id: str, params: dict[str, Any], ctx) -> dict[str, Any]:
    series = open_series(params["symbol"])
    decision_ts, prob, start, end = _decisions(params["model_run_id"], params)
    ctx.progress(0.1, f"Simulating {len(decision_ts):,} decisions", force=True)
    result = simulate(decision_ts, prob, series, engine_params(params))
    summary = summarize(result, start, end, params)

    ctx.progress(0.4, "Random-entry baseline", force=True)
    random = random_baseline(result, series, params, start, end, summary["return_pct"])
    ctx.progress(0.85, "Buy & hold baseline", force=True)
    hold = buy_and_hold(series, start, end, params)

    out = bt_dir(backtest_id)
    out.mkdir(parents=True, exist_ok=True)
    trades = pd.DataFrame(
        {
            "entry_ts": result["entry_ts"],
            "exit_ts": result["exit_ts"],
            "entry_price": result["entry_price"],
            "exit_price": result["exit_price"],
            "quantity": result["quantity"],
            "pnl": result["pnl"],
            "fees": result["fees"],
            "outcome": result["outcome"],
            "prob": result["prob"],
            "equity_after": result["equity_after"],
        }
    )
    pq.write_table(pa.Table.from_pandas(trades, preserve_index=False), out / "trades.parquet", compression="zstd")
    daily = daily_equity(result, start, end, params["initial_capital"])
    (out / "equity.json").write_text(json.dumps(downsample_equity(result, params, start)))
    (out / "baselines.json").write_text(json.dumps({"random": random, "buy_and_hold": hold}))
    (out / "monthly.json").write_text(json.dumps(monthly_returns(daily)))

    summary["vs_buy_and_hold_pct"] = summary["return_pct"] - hold["return_pct"]
    summary["random_mean_return_pct"] = random.get("mean_return_pct")
    summary["random_percentile"] = random.get("model_percentile")
    return summary


def run_sweep(backtest_id: str, params: dict[str, Any], ctx) -> dict[str, Any]:
    series = open_series(params["symbol"])
    decision_ts, prob, start, end = _decisions(params["model_run_id"], params)
    rows = []
    combos = [(threshold, tp, sl) for threshold in params["thresholds"] for tp, sl in params["tp_sl_pairs"]]
    for position, (threshold, tp, sl) in enumerate(combos):
        overrides = {"threshold": threshold, "tp_pct": tp, "sl_pct": sl}
        result = simulate(decision_ts, prob, series, engine_params(params, **overrides))
        summary = summarize(result, start, end, {**params, **overrides})
        rows.append({**overrides, **{key: summary[key] for key in ("trades", "win_rate", "return_pct", "profit_factor", "max_drawdown_pct", "sharpe", "fees_paid", "trades_per_day")}})
        ctx.progress((position + 1) / len(combos), f"Sweep {position + 1}/{len(combos)}")
    out = bt_dir(backtest_id)
    out.mkdir(parents=True, exist_ok=True)
    (out / "sweep.json").write_text(json.dumps(rows))
    best = max(rows, key=lambda row: row["return_pct"])
    return {"combinations": len(rows), "best": best, "start_ts": start, "end_ts": end}


def run_backtest_job(job_params: dict[str, Any], ctx) -> dict[str, Any]:
    backtest_id = job_params["backtest_id"]
    record = get_backtest(backtest_id)
    if record is None:
        raise ValueError("Backtest not found")
    params = record["params"]
    _set(backtest_id, "running")
    try:
        if params.get("kind") == "sweep":
            summary = run_sweep(backtest_id, params, ctx)
        else:
            summary = run_single(backtest_id, params, ctx)
    except BaseException:
        _set(backtest_id, "failed")
        raise
    _set(backtest_id, "done", summary)
    return {"backtest_id": backtest_id, **{key: value for key, value in summary.items() if key != "best"}}
