import pandas as pd

from app.models.walkforward import make_folds

FIRST = int(pd.Timestamp("2021-01-10", tz="UTC").timestamp())
LAST = int(pd.Timestamp("2023-06-15", tz="UTC").timestamp())
PURGE = 3600 + 120


def folds(window="rolling"):
    return make_folds(FIRST, LAST, train_months=12, test_months=3, min_train_months=6, window=window, purge_seconds=PURGE)


def test_no_training_label_can_overlap_validation_or_test():
    for fold in folds():
        assert fold.train_start < fold.train_end
        assert fold.train_end + PURGE <= fold.valid_start
        assert fold.valid_end + PURGE <= fold.test_start
        assert fold.test_start < fold.test_end


def test_test_windows_are_contiguous_and_cover_the_end():
    result = folds()
    for previous, current in zip(result, result[1:]):
        assert previous.test_end == current.test_start
    assert result[0].test_start == int(pd.Timestamp("2021-08-01", tz="UTC").timestamp())
    assert result[-1].test_end > LAST


def test_rolling_window_limits_training_history():
    for fold in folds("rolling"):
        assert fold.test_start - fold.train_start <= 366 * 86400
    expanding = folds("expanding")
    assert all(fold.train_start == expanding[0].train_start for fold in expanding)
