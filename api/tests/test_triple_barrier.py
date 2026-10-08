import numpy as np

from app.labels.triple_barrier import label_decisions, simulate_long_exit


def path(prices, highs=None, lows=None, opens=None):
    close = np.asarray(prices, dtype=np.float64)
    return (
        np.asarray(opens if opens is not None else close, dtype=np.float64),
        np.asarray(highs if highs is not None else close, dtype=np.float64),
        np.asarray(lows if lows is not None else close, dtype=np.float64),
        close,
    )


def test_take_profit_before_stop():
    open_, high, low, close = path([100, 100.2, 100.7, 99.0])
    outcome, index, price = simulate_long_exit(open_, high, low, close, 0, 100.0, 0.006, 0.004, 10)
    assert (outcome, index, price) == (1, 2, 100.6)


def test_stop_before_take_profit_fills_at_stop():
    open_, high, low, close = path([100, 99.8, 101.0], opens=[100, 100, 101.0], lows=[100, 99.5, 101.0])
    outcome, index, price = simulate_long_exit(open_, high, low, close, 0, 100.0, 0.006, 0.004, 10)
    assert (outcome, index) == (-1, 1)
    assert price == 99.6


def test_same_second_touching_both_barriers_counts_as_stop():
    open_, high, low, close = path([100, 100], highs=[100, 101], lows=[100, 99])
    outcome, index, _ = simulate_long_exit(open_, high, low, close, 0, 100.0, 0.006, 0.004, 10)
    assert (outcome, index) == (-1, 1)


def test_gap_through_the_stop_fills_at_the_open():
    open_, high, low, close = path([100, 98.0], opens=[100, 98.5], lows=[100, 98.0])
    outcome, _, price = simulate_long_exit(open_, high, low, close, 0, 100.0, 0.006, 0.004, 10)
    assert outcome == -1 and price == 98.5


def test_timeout_exits_at_the_last_close_and_skips_missing_seconds():
    open_, high, low, close = path([100, 100.1, np.nan, 100.2, 100.3])
    outcome, index, price = simulate_long_exit(open_, high, low, close, 0, 100.0, 0.006, 0.004, 3)
    assert (outcome, index, price) == (0, 3, 100.2)


def test_label_decisions_enters_after_latency_and_drops_incomplete_horizons():
    prices = np.full(400, 100.0)
    prices[70] = 100.7  # decision at second 0 + latency 1 -> enters at 1, tp hit at 70
    open_, high, low, close = path(prices)
    outcome, exit_seconds, exit_return = label_decisions(
        np.array([0, 395], dtype=np.int64), open_, high, low, close, 1, 0.006, 0.004, 100
    )
    assert outcome[0] == 1 and exit_seconds[0] == 69
    assert np.isclose(exit_return[0], 0.006)
    assert outcome[1] == -2  # horizon runs past the data
