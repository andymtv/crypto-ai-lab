"""Paths and market constants shared by every module."""

from __future__ import annotations

import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
PARQUET_DIR = DATA_DIR / "parquet"
SERIES_DIR = DATA_DIR / "series"
FEATURES_DIR = DATA_DIR / "features"
MODELS_DIR = DATA_DIR / "models"
BACKTESTS_DIR = DATA_DIR / "backtests"
JOBS_DIR = DATA_DIR / "jobs"
DB_PATH = DATA_DIR / "lab.sqlite"

# Coins downloaded by default and the default model setup: any Binance spot
# pair with 1s archives works. USDT pairs: the USDC pairs have long stretches
# of missing history on Binance.
DEFAULT_SYMBOLS = ("SOLUSDT", "BTCUSDT")
DEFAULT_TARGET = "SOLUSDT"
DEFAULT_CONTEXT = "BTCUSDT"

# LAB_HISTORY_START limits how much history is processed (e.g. a small slice
# on a low-memory machine). Downloads always fetch everything published.
HISTORY_START_MONTH = os.environ.get("LAB_HISTORY_START", "2017-01")

# CPU threads for model training.
THREADS = int(os.environ.get("LAB_THREADS", "0")) or (os.cpu_count() or 4)

BINANCE_VISION_URL = "https://data.binance.vision"

# Fallback minimum order size when Binance's filters cannot be fetched.
MIN_ORDER_NOTIONAL = 5.0


def ensure_dirs() -> None:
    for path in (PARQUET_DIR, SERIES_DIR, FEATURES_DIR, MODELS_DIR, BACKTESTS_DIR, JOBS_DIR):
        path.mkdir(parents=True, exist_ok=True)
