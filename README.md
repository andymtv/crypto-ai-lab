# SOL AI Lab

Research lab for **machine-learning signals on SOL**, with BTC as context.
It downloads Binance 1-second history, builds features, trains walk-forward
models and backtests their out-of-sample signals on the 1-second path.
**It does not trade.**

- API: FastAPI (Python 3.12, LightGBM, scikit-learn, numba) — http://localhost:8100
- UI: React + Vite + Tailwind (same design system as bot_manager) — http://localhost:3100

## Pipeline

```
data.binance.vision 1s klines (SOLUSDT, BTCUSDT; USDT pairs: the USDC
history has long gaps)
  └─ Parquet per symbol/month (checksummed, resumable)       data/parquet
      └─ dense per-second memory-mapped series               data/series
          └─ 1m bars + microstructure (1s realized vol, taker flow, gaps)
              └─ feature matrix on the 1m decision grid      data/features
                  ├─ triple-barrier labels on the 1s path
                  └─ walk-forward models → out-of-fold predictions
                      └─ backtests (1s fills, fees, slippage, min notional)
                         vs buy & hold and random entries
```

### Features (v1, ~150 columns)
Per coin (`sol_*`, `btc_*`): returns over 1m–1d, realized volatility from 1s
returns, ranges, Donchian / VWAP position, volume, trade-count and taker-flow
statistics, RSI / MACD / Bollinger / ATR / EMA distances / ADX on closed 5m,
15m and 1h bars. SOL candle shapes of the last five 5m bars. SOL vs BTC
(`x_*`): rolling beta and correlation, BTC-lead gaps (BTC moved, SOL has not
caught up), SOL residual returns. Calendar (`cal_*`).

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
notional. Compared against buy & hold and 30 random-entry runs with the same
trade frequency, exits and costs. A sweep runs threshold × TP/SL grids
(beware: picking the best combination on the same period overfits).

## Running

```bash
cp .env.example .env   # adjust per machine
docker compose up -d --build
```

Open http://localhost:3100 → **Data**: Download → Build series → (features
build automatically when training) → **Models**: train → **Backtester**.

### Machine settings (`.env`)

| Setting | Low-memory box (8 GB) | MacBook Pro M1 Max 64 GB |
|---|---|---|
| `API_MEM_LIMIT` | `4g` | `40g` |
| `LAB_HISTORY_START` | `2026-04` (small slice) | `2020-08` (everything) |
| `LAB_THREADS` | `3` | `0` (all cores) |

On macOS give Docker Desktop enough memory (Settings → Resources) for
`API_MEM_LIMIT`. Full history: ~9 GB download, ~20 GB of series files.

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
  data/        binance_vision.py (download), series.py (dense 1s + 1m bars)
  features/    indicators.py, build.py
  labels/      triple_barrier.py (numba)
  models/      walkforward.py, train.py
  backtest/    engine.py (numba), runner.py (baselines, sweep)
  routes/      data, models, backtests, jobs
  jobs.py / worker.py   background job runner
api/tests/     leakage, labels, engine, walk-forward, bars
web/           React UI
```
