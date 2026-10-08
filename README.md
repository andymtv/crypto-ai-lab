# Crypto AI Lab

Research lab for **machine-learning trading signals on any Binance spot
coin**, optionally with a second coin as context (by default: trade SOL,
watch BTC). It downloads Binance 1-second history, builds features, trains
walk-forward models and backtests their out-of-sample signals on the
1-second path. **It does not trade.**

- API: FastAPI (Python 3.12, LightGBM, scikit-learn, numba) — http://localhost:8100
- UI: React + Vite + Tailwind (same design system as bot_manager) — http://localhost:3100

## Pipeline

```
data.binance.vision 1s klines for any coins you add (default SOLUSDT +
BTCUSDT; prefer USDT pairs: the USDC history has long gaps)
  └─ Parquet per symbol/month (checksummed, resumable)       data/parquet
      └─ dense per-second memory-mapped series               data/series
          └─ 1m bars + microstructure (1s realized vol, taker flow, gaps)
              └─ feature matrix on the 1m decision grid      data/features
                  ├─ triple-barrier labels on the 1s path
                  └─ walk-forward models → out-of-fold predictions
                      └─ backtests (1s fills, fees, slippage, min notional)
                         vs buy & hold and random entries
```

### Coins
Any Binance spot pair with 1-second archives. A model has a **target** coin
(the one traded) and an optional **context** coin (e.g. BTC for alts). Feature
names are coin-agnostic, so the same design trains on SOL, ETH, XRP, ...
Quantity step and minimum notional come from Binance's exchange info per
coin. Add a coin on the Data page (validated against Binance first).

### Features (v1, ~150 columns with a context coin, ~80 without)
Per coin (`target_*`, `ctx_*`): returns over 1m–1d, realized volatility from 1s
returns, ranges, Donchian / VWAP position, volume, trade-count and taker-flow
statistics, RSI / MACD / Bollinger / ATR / EMA distances / ADX on closed 5m,
15m and 1h bars. Target candle shapes of the last five 5m bars. Target vs
context (`x_*`): rolling beta and correlation, context-lead gaps (BTC moved,
the alt has not caught up), the target's residual returns. Calendar
(`cal_*`).

A feature at decision time T only uses data available at T —
`api/tests/test_features_leakage.py` proves it by rebuilding on truncated
history.

### Labels
For each decision (close of a 1m bar): long entry at the open of the second
`decision + latency`; label 1 if `+tp%` is hit before `-sl%` within the
horizon on 1-second highs/lows (a second touching both counts as the stop).

### Models and validation
LightGBM (main) and logistic regression (linear baseline). Walk-forward by
month (rolling or expanding window), purged so no training label overlaps the
validation/test period, early stopping on the end of each training window.
Only **out-of-fold** predictions are kept for backtests; a final model is
fitted on the most recent window.

### Backtest
One long position at a time. Entry at the next second's open (+latency,
+slippage), take profit as a limit, stop as a stop-market (gap-aware),
timeout at market. Fees both sides, SOL quantity step, 5 USDT minimum
notional (the coin's Binance filters). Compared against buy & hold and 30
random-timing runs that shuffle the model's own waits between trades: same
number of trades, same exits and costs, only the timing is random. A sweep runs threshold × TP/SL grids
(beware: picking the best combination on the same period overfits).

## Running

```bash
cp .env.example .env   # adjust per machine
docker compose up -d --build
```

Open http://localhost:3100 → **Data**: add coins, Download → Build series →
(features build automatically when training) → **Models**: pick target and
context coins, train → **Backtester**.

### Machine settings (`.env`)

| Setting | Low-memory box (8 GB) | MacBook Pro M1 Max 64 GB |
|---|---|---|
| `API_MEM_LIMIT` | `4g` | `40g` |
| `LAB_HISTORY_START` | `2026-04` (small slice) | `2017-01` (everything) |
| `LAB_THREADS` | `3` | `0` (all cores) |

On macOS give Docker Desktop enough memory (Settings → Resources) for
`API_MEM_LIMIT`. Per coin with full history: roughly 3–6 GB download and
8–15 GB of series files (BTC/ETH go back to 2017-08, SOL to 2020-08).

Jobs run one at a time in a detached worker inside the API container; a
download/build interrupted by a restart resumes where it stopped (re-run it).

### Tests

```bash
docker exec -w /app sol-ai-lab-api python -m pytest -q tests
docker exec sol-ai-lab-web npm run build
docker exec sol-ai-lab-web npx vitest run
```

## Layout

```
api/app/
  data/        binance_vision.py (download), series.py (dense 1s + 1m bars),
               symbols.py (Binance filters, archive availability)
  features/    indicators.py, build.py
  labels/      triple_barrier.py (numba)
  models/      walkforward.py, train.py
  backtest/    engine.py (numba), runner.py (baselines, sweep)
  routes/      data, models, backtests, jobs
  jobs.py / worker.py   background job runner
api/tests/     leakage, labels, engine, walk-forward, bars
web/           React UI
```
