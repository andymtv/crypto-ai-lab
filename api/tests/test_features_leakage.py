"""A feature row may only use data available at its decision time.

Rebuilding the features on history truncated at an arbitrary minute must give
exactly the same values for every row up to that minute. Any look-ahead (a
centered window, an unclosed higher-timeframe bar, a negative shift) breaks it.
"""

import numpy as np
import pytest

from app.features.build import compute_features
from tests.helpers import random_minute_bars

MINUTES = 3 * 1440 + 17


@pytest.fixture(scope="module")
def bars():
    return random_minute_bars(MINUTES, seed=1, price=150.0), random_minute_bars(MINUTES, seed=2, price=60000.0)


@pytest.fixture(scope="module")
def full_features(bars):
    sol, btc = bars
    return compute_features(sol, btc)


@pytest.mark.parametrize("cut", [1500, 2222, 2879, 3600, 4000])
def test_features_do_not_change_when_the_future_is_removed(bars, full_features, cut):
    sol, btc = bars
    truncated = compute_features(sol.iloc[:cut], btc.iloc[:cut])
    assert len(truncated["ts"]) == cut
    leaking = [
        name
        for name, values in truncated.items()
        if not np.array_equal(values, full_features[name][:cut], equal_nan=True)
    ]
    assert leaking == []


def test_higher_timeframe_values_only_change_when_their_bar_closes(full_features):
    ts = full_features["ts"]
    rsi = full_features["sol_1h_rsi14"]
    changes = ts[1:][np.diff(np.nan_to_num(rsi, nan=-1)) != 0]
    # A 1h bar opening at H is known at the row of its last minute (H + 59 min).
    assert len(changes) > 0
    assert np.all(changes % 3600 == 3540)


def test_feature_matrix_has_no_infinities(full_features):
    for name, values in full_features.items():
        if name in ("ts", "valid"):
            continue
        assert not np.isinf(values).any(), name
