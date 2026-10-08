import numpy as np

from app.data.series import minute_bars_from_seconds
from tests.helpers import make_series


def test_minute_bar_uses_first_open_last_close_and_ignores_missing_seconds():
    close = np.linspace(100, 101, 120)
    close[0] = np.nan
    close[59] = np.nan
    open_ = close.copy()
    open_[1] = 99.0
    series = make_series(close, t0=1_700_000_040 - 1_700_000_040 % 60, open_=open_)
    series.trades[[0, 59]] = -1
    bars = minute_bars_from_seconds(series, 0, 120)
    assert len(bars) == 2
    assert bars["open"][0] == 99.0
    assert np.isclose(bars["close"][0], close[58])
    assert bars["missing_seconds"][0] == 2
    assert np.isclose(bars["close"][1], 101.0)
    assert bars["high"][1] == np.nanmax(close[60:120])


def test_fully_missing_minute_has_nan_prices():
    close = np.full(60, np.nan)
    series = make_series(close, t0=1_700_000_040 - 1_700_000_040 % 60)
    series.trades[:] = -1
    bars = minute_bars_from_seconds(series, 0, 60)
    assert np.isnan(bars["close"][0]) and bars["missing_seconds"][0] == 60
