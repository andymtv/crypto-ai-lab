import numpy as np

from app.backtest.engine import EngineParams, simulate
from tests.helpers import make_series

T0 = 1_700_000_000


def params(**overrides):
    base = dict(
        threshold=0.6,
        tp_pct=1.0,
        sl_pct=1.0,
        max_hold_minutes=10,
        fee_pct=0.1,
        slippage_bps=0.0,
        latency_seconds=1,
        initial_capital=10.0,
        sizing="compound",
        order_quote=10.0,
        compound_fraction=1.0,
        min_notional=5.0,
        qty_step=0.001,
        cooldown_minutes=0,
    )
    base.update(overrides)
    return EngineParams(**base)


def rising_series(seconds=3000, start=100.0):
    close = np.full(seconds, start)
    close[200:] = start * 1.02  # take profit reached at second 200
    return make_series(close, t0=T0)


def test_take_profit_trade_accounts_for_fees_and_quantity_step():
    series = rising_series()
    result = simulate(np.array([T0]), np.array([0.9], dtype=np.float32), series, params())
    assert result["count"] == 1
    qty = result["quantity"][0]
    assert np.isclose(qty, np.floor(10 / (100 * 1.001) / 0.001) * 0.001)
    expected = qty * 101.0 * (1 - 0.001) - qty * 100.0 * (1 + 0.001)
    assert np.isclose(result["pnl"][0], expected)
    assert result["outcome"][0] == 1
    assert result["entry_ts"][0] == T0 + 1


def test_signals_below_threshold_are_ignored():
    result = simulate(np.array([T0]), np.array([0.5], dtype=np.float32), rising_series(), params())
    assert result["count"] == 0


def test_only_one_position_at_a_time():
    decisions = np.array([T0, T0 + 60, T0 + 300])
    result = simulate(decisions, np.full(3, 0.9, dtype=np.float32), rising_series(), params())
    # The first trade exits at second 200, so the decision at +60 is skipped.
    assert result["count"] == 2
    assert result["entry_ts"][1] == T0 + 301


def test_orders_below_min_notional_are_skipped():
    result = simulate(np.array([T0]), np.array([0.9], dtype=np.float32), rising_series(), params(initial_capital=4.0))
    assert result["count"] == 0 and result["skipped_small"] == 1


def test_slippage_worsens_entry_and_stop_exit():
    close = np.full(1000, 100.0)
    close[100:] = 98.0
    series = make_series(close, t0=T0)
    result = simulate(np.array([T0]), np.array([0.9], dtype=np.float32), series, params(slippage_bps=10))
    assert result["outcome"][0] == -1
    assert np.isclose(result["entry_price"][0], 100.1)
    # Gapped through the stop: filled at the second's open, minus slippage.
    assert np.isclose(result["exit_price"][0], 98.0 * 0.999)


def test_cooldown_delays_the_next_entry():
    decisions = np.array([T0, T0 + 300, T0 + 600])
    result = simulate(decisions, np.full(3, 0.9, dtype=np.float32), rising_series(), params(cooldown_minutes=6))
    assert result["count"] == 2
    assert result["entry_ts"][1] == T0 + 601


def test_random_baseline_matches_the_model_trade_count():
    from app.backtest.runner import normalize_params, random_baseline

    rng = np.random.default_rng(3)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.0004, 200_000)))
    series = make_series(close, t0=T0)
    decisions = T0 + np.arange(0, 199_000, 60)
    # Clustered signals: long runs above the threshold.
    prob = np.where((np.arange(len(decisions)) // 40) % 5 == 0, 0.9, 0.1).astype(np.float32)
    label = {"tp_pct": 0.6, "sl_pct": 0.4, "horizon_minutes": 60, "latency_seconds": 1}
    run_params = normalize_params({"model_run_id": "x", "threshold": 0.6, "sizing": "fixed", "initial_capital": 100}, {"label": label})
    model = simulate(decisions, prob, series, engine_params_from(run_params))
    baseline = random_baseline(model, series, run_params, int(decisions[0]), int(decisions[-1]), 0.0)
    assert model["count"] > 10
    assert abs(baseline["mean_trades"] - model["count"]) <= max(2, 0.1 * model["count"])


def engine_params_from(run_params):
    from app.backtest.runner import engine_params

    return engine_params(run_params)


def test_unshuffled_gaps_reproduce_the_model_trades():
    from app.backtest.engine import simulate_with_gaps

    decisions = np.array([T0 + 60, T0 + 600, T0 + 1200])
    p = params(cooldown_minutes=0)
    model = simulate(decisions, np.full(3, 0.9, dtype=np.float32), rising_series(), p)
    previous_exit = np.concatenate([[T0], model["exit_ts"][:-1]])
    gaps = model["entry_ts"] - p.latency_seconds - previous_exit
    trades, equity = simulate_with_gaps(gaps, T0, T0 + 3000, rising_series(), p)
    assert trades == model["count"]
    assert np.isclose(equity, model["equity_after"][-1])
