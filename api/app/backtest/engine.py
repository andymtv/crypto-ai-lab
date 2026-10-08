"""Backtest engine: model probabilities -> long trades simulated on 1s data.

One position at a time (spot, long only). At each decision (the close of a
1m bar) with probability >= threshold while flat, buy at the open of the
second `decision + latency` (plus slippage), then exit on the 1-second path:

- take profit: limit order at entry * (1 + tp), filled at that price;
- stop loss: stop at entry * (1 - sl), filled at the stop or at the second's
  open if price gapped through it, minus slippage;
- timeout: market sell at the close of the last second of the holding window.

A second touching both levels counts as a stop (we cannot see the order).
Quantities are rounded down to the exchange step; orders below the minimum
notional are skipped. Fees are charged on both sides.
"""

from __future__ import annotations

from dataclasses import dataclass

import numba
import numpy as np

from ..labels.triple_barrier import first_valid_at_or_after, simulate_long_exit

SIZING_FIXED = 0
SIZING_COMPOUND = 1


@dataclass
class EngineParams:
    threshold: float
    tp_pct: float
    sl_pct: float
    max_hold_minutes: int
    fee_pct: float
    slippage_bps: float
    latency_seconds: int
    initial_capital: float
    sizing: str  # "fixed" | "compound"
    order_quote: float
    compound_fraction: float
    min_notional: float
    qty_step: float
    cooldown_minutes: int


@numba.njit(cache=True)
def _execute_trade(
    entry_index: int,
    equity: float,
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    tp: float,
    sl: float,
    horizon_seconds: int,
    fee: float,
    slippage: float,
    sizing: int,
    order_quote: float,
    compound_fraction: float,
    min_notional: float,
    qty_step: float,
):
    """(status, exit_index, fill, sell, qty, profit, fees, outcome); status 0 ok, 1 too small, 2 no data."""
    reference = open_[entry_index]
    if np.isnan(reference):
        reference = close[entry_index]
    fill = reference * (1.0 + slippage)
    if sizing == 0:
        quote = min(order_quote, equity)
    else:
        quote = equity * compound_fraction
    qty = np.floor(quote / (fill * (1.0 + fee)) / qty_step) * qty_step
    notional = qty * fill
    if notional < min_notional or qty <= 0:
        return 1, entry_index, fill, 0.0, 0.0, 0.0, 0.0, 0
    result, exit_index, exit_level = simulate_long_exit(open_, high, low, close, entry_index, fill, tp, sl, horizon_seconds)
    if result == -2:
        return 2, entry_index, fill, 0.0, 0.0, 0.0, 0.0, 0
    # Take profit is a resting limit order: no slippage.
    sell = exit_level if result == 1 else exit_level * (1.0 - slippage)
    fee_in = notional * fee
    proceeds = qty * sell
    fee_out = proceeds * fee
    return 0, exit_index, fill, sell, qty, proceeds - fee_out - notional - fee_in, fee_in + fee_out, result


@numba.njit(cache=True)
def _simulate(
    decision_ts: np.ndarray,
    prob: np.ndarray,
    t0: int,
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    threshold: float,
    tp: float,
    sl: float,
    horizon_seconds: int,
    fee: float,
    slippage: float,
    latency: int,
    initial_capital: float,
    sizing: int,
    order_quote: float,
    compound_fraction: float,
    min_notional: float,
    qty_step: float,
    cooldown_seconds: int,
):
    count = decision_ts.shape[0]
    entry_ts = np.zeros(count, dtype=np.int64)
    exit_ts = np.zeros(count, dtype=np.int64)
    entry_price = np.zeros(count, dtype=np.float64)
    exit_price = np.zeros(count, dtype=np.float64)
    quantity = np.zeros(count, dtype=np.float64)
    pnl = np.zeros(count, dtype=np.float64)
    fees = np.zeros(count, dtype=np.float64)
    outcome = np.zeros(count, dtype=np.int8)
    trade_prob = np.zeros(count, dtype=np.float32)
    equity_after = np.zeros(count, dtype=np.float64)

    equity = initial_capital
    trades = 0
    skipped_small = 0
    next_allowed = -1
    for i in range(count):
        if decision_ts[i] < next_allowed or prob[i] < threshold:
            continue
        start = decision_ts[i] + latency - t0
        if start < 0 or start >= close.shape[0]:
            continue
        entry_index = first_valid_at_or_after(close, start, 10)
        if entry_index < 0:
            continue
        status, exit_index, fill, sell, qty, profit, trade_fees, result = _execute_trade(
            entry_index, equity, open_, high, low, close, tp, sl, horizon_seconds, fee, slippage,
            sizing, order_quote, compound_fraction, min_notional, qty_step,
        )
        if status == 1:
            skipped_small += 1
            continue
        if status == 2:
            continue
        equity += profit

        entry_ts[trades] = t0 + entry_index
        exit_ts[trades] = t0 + exit_index
        entry_price[trades] = fill
        exit_price[trades] = sell
        quantity[trades] = qty
        pnl[trades] = profit
        fees[trades] = trade_fees
        outcome[trades] = result
        trade_prob[trades] = prob[i]
        equity_after[trades] = equity
        trades += 1
        next_allowed = t0 + exit_index + cooldown_seconds

    return (
        trades,
        skipped_small,
        entry_ts[:trades],
        exit_ts[:trades],
        entry_price[:trades],
        exit_price[:trades],
        quantity[:trades],
        pnl[:trades],
        fees[:trades],
        outcome[:trades],
        trade_prob[:trades],
        equity_after[:trades],
    )


def simulate(decision_ts: np.ndarray, prob: np.ndarray, series, params: EngineParams) -> dict:
    result = _simulate(
        decision_ts.astype(np.int64),
        prob.astype(np.float32),
        int(series.t0),
        np.asarray(series.open),
        np.asarray(series.high),
        np.asarray(series.low),
        np.asarray(series.close),
        float(params.threshold),
        params.tp_pct / 100.0,
        params.sl_pct / 100.0,
        int(params.max_hold_minutes * 60),
        params.fee_pct / 100.0,
        params.slippage_bps / 10_000.0,
        int(params.latency_seconds),
        float(params.initial_capital),
        SIZING_COMPOUND if params.sizing == "compound" else SIZING_FIXED,
        float(params.order_quote),
        float(params.compound_fraction),
        float(params.min_notional),
        float(params.qty_step),
        int(params.cooldown_minutes * 60),
    )
    keys = (
        "count",
        "skipped_small",
        "entry_ts",
        "exit_ts",
        "entry_price",
        "exit_price",
        "quantity",
        "pnl",
        "fees",
        "outcome",
        "prob",
        "equity_after",
    )
    return dict(zip(keys, result))


@numba.njit(cache=True)
def _simulate_gaps(
    gaps: np.ndarray,
    start_ts: int,
    end_ts: int,
    t0: int,
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    tp: float,
    sl: float,
    horizon_seconds: int,
    fee: float,
    slippage: float,
    latency: int,
    initial_capital: float,
    sizing: int,
    order_quote: float,
    compound_fraction: float,
    min_notional: float,
    qty_step: float,
):
    """Trades entered after the given waiting gaps (seconds since the previous exit)."""
    equity = initial_capital
    trades = 0
    now = start_ts
    for k in range(gaps.shape[0]):
        decision = now + gaps[k]
        if decision % 60 != 0:
            decision += 60 - decision % 60  # decisions happen on 1m closes
        if decision >= end_ts:
            break
        entry_index = first_valid_at_or_after(close, decision + latency - t0, 10)
        if entry_index < 0:
            break
        status, exit_index, fill, sell, qty, profit, trade_fees, result = _execute_trade(
            entry_index, equity, open_, high, low, close, tp, sl, horizon_seconds, fee, slippage,
            sizing, order_quote, compound_fraction, min_notional, qty_step,
        )
        if status == 2:
            break
        if status == 0:
            equity += profit
            trades += 1
            now = t0 + exit_index
        else:
            now = decision
    return trades, equity


def simulate_with_gaps(gaps: np.ndarray, start_ts: int, end_ts: int, series, params: EngineParams) -> tuple[int, float]:
    trades, equity = _simulate_gaps(
        gaps.astype(np.int64),
        int(start_ts),
        int(end_ts),
        int(series.t0),
        np.asarray(series.open),
        np.asarray(series.high),
        np.asarray(series.low),
        np.asarray(series.close),
        params.tp_pct / 100.0,
        params.sl_pct / 100.0,
        int(params.max_hold_minutes * 60),
        params.fee_pct / 100.0,
        params.slippage_bps / 10_000.0,
        int(params.latency_seconds),
        float(params.initial_capital),
        SIZING_COMPOUND if params.sizing == "compound" else SIZING_FIXED,
        float(params.order_quote),
        float(params.compound_fraction),
        float(params.min_notional),
        float(params.qty_step),
    )
    return int(trades), float(equity)
