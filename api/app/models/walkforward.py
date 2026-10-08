"""Walk-forward folds by calendar month, with purging.

Each fold trains on data strictly before its test window and is tested on the
next `test_months`. Training rows whose label could still be open when the
test window starts (decision + horizon + latency) are purged, so no test-period
price ever leaks into training. The last part of each training window is held
out (after another purge gap) for early stopping.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd


@dataclass
class Fold:
    index: int
    train_start: int
    train_end: int  # exclusive, already purged
    valid_start: int
    valid_end: int  # exclusive, purged before test_start
    test_start: int
    test_end: int  # exclusive

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


def month_start(ts: int) -> pd.Timestamp:
    stamp = pd.Timestamp(ts, unit="s", tz="UTC")
    return pd.Timestamp(year=stamp.year, month=stamp.month, day=1, tz="UTC")


def make_folds(
    first_ts: int,
    last_ts: int,
    *,
    train_months: int,
    test_months: int,
    min_train_months: int,
    window: str,
    purge_seconds: int,
    valid_fraction: float = 0.15,
) -> list[Fold]:
    data_start = month_start(first_ts) + pd.offsets.MonthBegin(1)  # first full month
    folds: list[Fold] = []
    test_start = data_start + pd.DateOffset(months=min_train_months)
    end = pd.Timestamp(last_ts, unit="s", tz="UTC")

    while test_start < end:
        test_end = min(test_start + pd.DateOffset(months=test_months), end + pd.Timedelta(seconds=60))
        if window == "rolling":
            train_start = max(data_start, test_start - pd.DateOffset(months=train_months))
        else:
            train_start = data_start
        train_stop = int(test_start.timestamp()) - purge_seconds
        span = train_stop - int(train_start.timestamp())
        valid_start = int(train_start.timestamp()) + int(span * (1 - valid_fraction))
        folds.append(
            Fold(
                index=len(folds),
                train_start=int(train_start.timestamp()),
                train_end=valid_start - purge_seconds,
                valid_start=valid_start,
                valid_end=train_stop,
                test_start=int(test_start.timestamp()),
                test_end=int(test_end.timestamp()),
            )
        )
        test_start = test_start + pd.DateOffset(months=test_months)
    return folds
