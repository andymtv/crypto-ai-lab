import numpy as np
import pandas as pd

from app.data.series import Series


def make_series(close: np.ndarray, t0: int = 1_700_000_000, high=None, low=None, open_=None) -> Series:
    close = np.asarray(close, dtype=np.float64)
    length = len(close)
    return Series(
        symbol="TEST",
        t0=t0,
        length=length,
        open=np.asarray(open_ if open_ is not None else close, dtype=np.float64),
        high=np.asarray(high if high is not None else close, dtype=np.float64),
        low=np.asarray(low if low is not None else close, dtype=np.float64),
        close=close,
        volume=np.ones(length, dtype=np.float32),
        quote_volume=close.astype(np.float32),
        taker_buy_base=np.full(length, 0.5, dtype=np.float32),
        trades=np.ones(length, dtype=np.int32),
    )


def random_minute_bars(minutes: int, seed: int, start_ts: int = 1_700_000_040 - 1_700_000_040 % 60, price: float = 100.0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = price * np.exp(np.cumsum(rng.normal(0, 0.001, minutes)))
    open_ = np.concatenate([[price], close[:-1]])
    spread = np.abs(rng.normal(0, 0.0005, minutes)) * close
    volume = rng.uniform(10, 100, minutes)
    return pd.DataFrame(
        {
            "ts": start_ts + np.arange(minutes, dtype=np.int64) * 60,
            "open": open_,
            "high": np.maximum(open_, close) + spread,
            "low": np.minimum(open_, close) - spread,
            "close": close,
            "volume": volume.astype(np.float32),
            "quote_volume": (volume * close).astype(np.float32),
            "trades": rng.integers(1, 50, minutes).astype(np.int32),
            "taker_buy_share": rng.uniform(0.3, 0.7, minutes).astype(np.float32),
            "realized_vol": rng.uniform(0.0005, 0.002, minutes).astype(np.float32),
            "max_second_move": rng.uniform(0.0001, 0.001, minutes).astype(np.float32),
            "missing_seconds": np.zeros(minutes, dtype=np.int16),
        }
    )
