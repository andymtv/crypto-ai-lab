"""Downloads Binance spot 1s klines from data.binance.vision into Parquet.

Any spot symbol works; every published monthly archive is fetched (optionally
from `start_month` on).

One Parquet file per symbol and month (`parquet/<SYMBOL>/<YYYY-MM>.parquet`).
Months already on disk are skipped, so the job is resumable. The current
month is not published as a monthly archive yet; it is assembled from daily
archives and replaced by the monthly one once that exists.

Every archive is checked against its published SHA-256 before conversion.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..config import BINANCE_VISION_URL, DEFAULT_SYMBOLS, PARQUET_DIR
from .symbols import list_archive_months, normalize_symbol

KLINE_COLUMNS = [
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
    "ignore",
]

PARQUET_SCHEMA = pa.schema(
    [
        ("ts", pa.int64()),  # unix seconds (bar open)
        ("open", pa.float64()),
        ("high", pa.float64()),
        ("low", pa.float64()),
        ("close", pa.float64()),
        ("volume", pa.float32()),
        ("quote_volume", pa.float32()),
        ("trades", pa.int32()),
        ("taker_buy_base", pa.float32()),
    ]
)


class ChecksumMismatch(Exception):
    pass


def month_range(start: str, end: str) -> list[str]:
    year, month = map(int, start.split("-"))
    end_year, end_month = map(int, end.split("-"))
    months = []
    while (year, month) <= (end_year, end_month):
        months.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return months


def month_path(symbol: str, month: str) -> Path:
    return PARQUET_DIR / symbol / f"{month}.parquet"


def daily_dir(symbol: str, month: str) -> Path:
    return PARQUET_DIR / symbol / "daily" / month


def parse_kline_csv(raw: bytes) -> pd.DataFrame:
    frame = pd.read_csv(
        io.BytesIO(raw),
        header=None,
        names=KLINE_COLUMNS,
        usecols=["open_time", "open", "high", "low", "close", "volume", "quote_volume", "trades", "taker_buy_base"],
        dtype={
            "open_time": np.int64,
            "open": np.float64,
            "high": np.float64,
            "low": np.float64,
            "close": np.float64,
            "volume": np.float32,
            "quote_volume": np.float32,
            "trades": np.int32,
            "taker_buy_base": np.float32,
        },
    )
    open_time = frame.pop("open_time").to_numpy()
    # Binance switched spot archives from milliseconds to microseconds in 2025.
    seconds = np.where(open_time >= 10**15, open_time // 1_000_000, open_time // 1_000)
    frame.insert(0, "ts", seconds.astype(np.int64))
    return frame.sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)


def write_parquet(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(frame, schema=PARQUET_SCHEMA, preserve_index=False)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)


def fetch_archive(client: httpx.Client, url: str) -> bytes | None:
    """Returns the verified archive bytes, or None if it is not published."""
    response = client.get(url)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    payload = response.content

    checksum = client.get(f"{url}.CHECKSUM")
    if checksum.status_code == 200:
        expected = checksum.text.split()[0].strip().lower()
        actual = hashlib.sha256(payload).hexdigest()
        if expected != actual:
            raise ChecksumMismatch(f"{url}: expected {expected}, got {actual}")
    return payload


def unzip_single(payload: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read(archive.namelist()[0])


def download_month(client: httpx.Client, symbol: str, month: str) -> str:
    url = f"{BINANCE_VISION_URL}/data/spot/monthly/klines/{symbol}/1s/{symbol}-1s-{month}.zip"
    payload = fetch_archive(client, url)
    if payload is None:
        return "missing"
    write_parquet(parse_kline_csv(unzip_single(payload)), month_path(symbol, month))
    # The monthly archive supersedes any daily files of that month.
    for leftover in daily_dir(symbol, month).glob("*.parquet"):
        leftover.unlink()
    return "downloaded"


def download_days(client: httpx.Client, symbol: str, month: str, last_day: date) -> int:
    """Assembles a not-yet-published month from daily archives. Returns days added."""
    year, mon = map(int, month.split("-"))
    day = date(year, mon, 1)
    added = 0
    while day <= last_day and day.month == mon:
        path = daily_dir(symbol, month) / f"{day.isoformat()}.parquet"
        if not path.exists():
            url = f"{BINANCE_VISION_URL}/data/spot/daily/klines/{symbol}/1s/{symbol}-1s-{day.isoformat()}.zip"
            payload = fetch_archive(client, url)
            if payload is None:
                break
            write_parquet(parse_kline_csv(unzip_single(payload)), path)
            added += 1
        day += timedelta(days=1)
    return added


def download_history(params: dict[str, Any], ctx) -> dict[str, Any]:
    symbols = [normalize_symbol(symbol) for symbol in (params.get("symbols") or DEFAULT_SYMBOLS)]
    start = params.get("start_month")
    today = datetime.now(timezone.utc).date()
    current_month = today.strftime("%Y-%m")
    previous_month = (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    summary: dict[str, Any] = {"downloaded": [], "missing": [], "daily_days_added": 0, "symbols": symbols}

    with httpx.Client(timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=True) as client:
        published = {}
        for symbol in symbols:
            months = list_archive_months(symbol, client)
            if not months:
                raise ValueError(f"Binance publishes no 1s archives for {symbol}.")
            published[symbol] = [month for month in months if not start or month >= start]

        todo = [(symbol, month) for symbol in symbols for month in published[symbol] if not month_path(symbol, month).exists()]
        total = len(todo) + len(symbols)
        done = 0
        ctx.progress(0, f"{len(todo)} monthly archives to download for {', '.join(symbols)}.", force=True)

        with ThreadPoolExecutor(max_workers=int(params.get("workers", 3))) as pool:
            futures = {pool.submit(download_month, client, symbol, month): (symbol, month) for symbol, month in todo}
            for future in as_completed(futures):
                symbol, month = futures[future]
                status = future.result()
                summary[status].append(f"{symbol} {month}")
                done += 1
                ctx.progress(done / total, f"{symbol} {month}: {status} ({done}/{len(todo)})")

        # The month in progress (and the previous one, if its monthly archive
        # is not out yet) comes from daily archives up to yesterday.
        yesterday = today - timedelta(days=1)
        for symbol in symbols:
            for month in (previous_month, current_month):
                if month_path(symbol, month).exists():
                    continue
                summary["daily_days_added"] += download_days(client, symbol, month, yesterday)
            done += 1
            ctx.progress(done / total, f"{symbol}: daily archives up to {yesterday.isoformat()} checked.")

    return summary


def read_month(symbol: str, month: str) -> pd.DataFrame | None:
    """The month's 1s rows (monthly file, or the daily files assembled so far)."""
    path = month_path(symbol, month)
    if path.exists():
        return pq.read_table(path).to_pandas()
    days = sorted(daily_dir(symbol, month).glob("*.parquet"))
    if not days:
        return None
    return pd.concat([pq.read_table(day).to_pandas() for day in days], ignore_index=True)


def available_months(symbol: str) -> list[str]:
    folder = PARQUET_DIR / symbol
    if not folder.exists():
        return []
    months = {path.stem for path in folder.glob("*.parquet")}
    months |= {path.name for path in (folder / "daily").glob("*") if any(path.glob("*.parquet"))}
    return sorted(months)
