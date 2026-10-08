"""Paths and market constants shared by every module."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
PARQUET_DIR = DATA_DIR / "parquet"
SERIES_DIR = DATA_DIR / "series"
FEATURES_DIR = DATA_DIR / "features"
MODELS_DIR = DATA_DIR / "models"
BACKTESTS_DIR = DATA_DIR / "backtests"
JOBS_DIR = DATA_DIR / "jobs"
DB_PATH = DATA_DIR / "lab.sqlite"

# The traded coin and the context coin. USDT pairs: the USDC pairs have long
# stretches of missing history on Binance.
TARGET_SYMBOL = "SOLUSDT"
CONTEXT_SYMBOL = "BTCUSDT"
SYMBOLS = (TARGET_SYMBOL, CONTEXT_SYMBOL)

# First month with SOL 1s history; BTC is only useful where both exist.
# LAB_HISTORY_START limits how much history is processed (e.g. a small slice
# on a low-memory machine); downloads always start at SOL's listing.
DOWNLOAD_START_MONTH = "2020-08"
HISTORY_START_MONTH = os.environ.get("LAB_HISTORY_START", DOWNLOAD_START_MONTH)

# CPU threads for model training.
THREADS = int(os.environ.get("LAB_THREADS", "0")) or (os.cpu_count() or 4)

# Dense per-second series start here: index = seconds since SERIES_T0.
SERIES_T0 = int(
    datetime(int(HISTORY_START_MONTH[:4]), int(HISTORY_START_MONTH[5:7]), 1, tzinfo=timezone.utc).timestamp()
)

BINANCE_VISION_URL = "https://data.binance.vision"

# Binance spot SOLUSDT filters (used by the backtest's order sizing).
SOL_QTY_STEP = 0.001
MIN_ORDER_NOTIONAL = 5.0


def ensure_dirs() -> None:
    for path in (PARQUET_DIR, SERIES_DIR, FEATURES_DIR, MODELS_DIR, BACKTESTS_DIR, JOBS_DIR):
        path.mkdir(parents=True, exist_ok=True)
