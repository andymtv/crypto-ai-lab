"""Coin metadata: Binance trading filters and 1s archive availability.

Any Binance spot pair with 1-second archives can be used. Filters (quantity
step, minimum notional) come from Binance's exchangeInfo and are cached in
`symbols.json`, so backtests size orders like the exchange would.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ElementTree
from typing import Any

import httpx

from ..config import DATA_DIR, MIN_ORDER_NOTIONAL, PARQUET_DIR

EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo"
ARCHIVE_LISTING_URL = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
SYMBOL_PATTERN = re.compile(r"^[A-Z0-9]{2,20}$")
CACHE_PATH = DATA_DIR / "symbols.json"


def normalize_symbol(symbol: str) -> str:
    value = (symbol or "").strip().upper()
    if not SYMBOL_PATTERN.match(value):
        raise ValueError(f"Invalid symbol: {symbol!r}")
    return value


def _load_cache() -> dict[str, Any]:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def _save_cache(cache: dict[str, Any]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=1))


def list_archive_months(symbol: str, client: httpx.Client | None = None) -> list[str]:
    """Months with a published 1s monthly archive for the symbol, oldest first."""
    own = client is None
    client = client or httpx.Client(timeout=30)
    try:
        months: list[str] = []
        marker = ""
        prefix = f"data/spot/monthly/klines/{symbol}/1s/"
        while True:
            response = client.get(ARCHIVE_LISTING_URL, params={"delimiter": "/", "prefix": prefix, "marker": marker})
            response.raise_for_status()
            root = ElementTree.fromstring(response.content)
            namespace = {"s3": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
            find = (lambda node, tag: node.findall(f"s3:{tag}", namespace)) if namespace else (lambda node, tag: node.findall(tag))
            keys = [element.findtext("s3:Key" if namespace else "Key", namespaces=namespace) for element in find(root, "Contents")]
            for key in keys:
                match = re.search(r"-1s-(\d{4}-\d{2})\.zip$", key or "")
                if match:
                    months.append(match.group(1))
            truncated = (root.findtext("s3:IsTruncated" if namespace else "IsTruncated", namespaces=namespace) or "").lower() == "true"
            if not truncated or not keys:
                break
            marker = keys[-1]
        return sorted(set(months))
    finally:
        if own:
            client.close()


def fetch_filters(symbol: str, client: httpx.Client) -> dict[str, Any] | None:
    response = client.get(EXCHANGE_INFO_URL, params={"symbol": symbol})
    if response.status_code == 400:
        return None
    response.raise_for_status()
    info = response.json()["symbols"][0]
    filters = {item["filterType"]: item for item in info.get("filters", [])}
    lot = filters.get("LOT_SIZE", {})
    notional = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
    return {
        "base_asset": info.get("baseAsset"),
        "quote_asset": info.get("quoteAsset"),
        "status": info.get("status"),
        "qty_step": float(lot.get("stepSize", 0.00001)),
        "min_notional": float(notional.get("minNotional", MIN_ORDER_NOTIONAL)),
    }


def symbol_info(symbol: str, refresh: bool = False) -> dict[str, Any]:
    """{symbol, valid, first_month, last_month, qty_step, min_notional, ...} (cached)."""
    symbol = normalize_symbol(symbol)
    cache = _load_cache()
    if not refresh and symbol in cache:
        return cache[symbol]
    with httpx.Client(timeout=30) as client:
        filters = fetch_filters(symbol, client)
        months = list_archive_months(symbol, client) if filters else []
    info = {
        "symbol": symbol,
        "valid": bool(filters) and bool(months),
        "first_month": months[0] if months else None,
        "last_month": months[-1] if months else None,
        "archive_months": len(months),
        **(filters or {"qty_step": None, "min_notional": None}),
    }
    if info["valid"]:
        cache[symbol] = info
        _save_cache(cache)
    return info


def local_symbols() -> list[str]:
    """Symbols with downloaded data on disk."""
    if not PARQUET_DIR.exists():
        return []
    return sorted(path.name for path in PARQUET_DIR.iterdir() if path.is_dir() and any(path.rglob("*.parquet")))


def order_filters(symbol: str) -> tuple[float, float]:
    """(qty_step, min_notional) for backtests; falls back to safe defaults offline."""
    try:
        info = symbol_info(symbol)
        return float(info["qty_step"] or 0.00001), float(info["min_notional"] or MIN_ORDER_NOTIONAL)
    except Exception:
        return 0.00001, MIN_ORDER_NOTIONAL
