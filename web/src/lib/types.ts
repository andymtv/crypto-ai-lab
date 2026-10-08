// Mirrors of the FastAPI JSON contracts (api/app/routes/*). Timestamps are unix SECONDS (UTC);
// created_at / started_at / finished_at / built_at are float seconds.

export type JobKind = 'download' | 'build_series' | 'build_features' | 'train' | 'backtest';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  message: string | null;
  result: unknown;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  pid: number | null;
}

// ---- Data -------------------------------------------------------------------------------------

export interface MonthCoverage {
  month: string; // "YYYY-MM"
  rows: number;
  first_ts: number;
  last_ts: number;
  missing_seconds: number;
  largest_gap_seconds: number;
  partial: boolean;
}

export interface SymbolCoverage {
  symbol: string;
  downloaded_months: string[];
  built_months: string[];
  months: MonthCoverage[];
  length_seconds: number;
  first_ts: number | null;
  last_ts: number | null;
  missing_seconds: number;
  bars_built: boolean;
  bars_updated_at: number | null;
}

// One feature matrix per (target coin, context coin) pair. Sets built before multi-coin
// support have no target/context.
export interface FeatureSummary {
  target?: string;
  context?: string | null;
  feature_set: string;
  rows: number;
  first_ts: number;
  last_ts: number;
  built_at: number;
  build_seconds?: number;
  source_bars_mtime?: number;
  feature_count: number;
}

export interface FeatureMeta extends Omit<FeatureSummary, 'feature_count'> {
  columns: string[];
}

export interface DataStatus {
  symbols: SymbolCoverage[];
  features: FeatureSummary[];
  active_jobs: Record<'download' | 'build_series' | 'build_features', Job | null>;
}

// GET /api/data/symbols/validate
export interface SymbolInfo {
  symbol: string;
  valid: boolean;
  first_month: string | null;
  last_month?: string | null;
  archive_months?: number;
  base_asset?: string | null;
  quote_asset?: string | null;
  status?: string | null;
  qty_step: number | null;
  min_notional: number | null;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
  t: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
}

export interface CandlesResponse {
  symbol: string;
  tf: Timeframe;
  candles: Candle[];
}

// ---- Models -----------------------------------------------------------------------------------

export type ModelType = 'lgbm' | 'logreg';
export type WindowMode = 'rolling' | 'expanding';

export interface LabelConfig {
  tp_pct: number;
  sl_pct: number;
  horizon_minutes: number;
  latency_seconds: number;
}

export interface WalkForwardConfig {
  train_months: number;
  test_months: number;
  min_train_months: number;
  window: WindowMode;
}

export interface LgbmParams {
  num_leaves: number;
  learning_rate: number;
  min_data_in_leaf: number;
  feature_fraction: number;
  max_rounds: number;
}

export interface ModelParams {
  name: string;
  model_type: ModelType;
  label: LabelConfig;
  walk_forward: WalkForwardConfig;
  train_stride_minutes: number;
  // Runs created before multi-coin support have no symbols, only include_btc.
  target_symbol?: string;
  context_symbol?: string | null;
  include_btc?: boolean;
  fee_pct: number;
  lgbm: LgbmParams;
}

export type TrainRequest = Omit<ModelParams, 'name' | 'include_btc' | 'target_symbol' | 'context_symbol'> & {
  name?: string;
  target_symbol: string;
  context_symbol: string | null;
};

// classification_metrics(): {n: 0} when a fold had no rows, otherwise the full set.
export interface ClassificationMetrics {
  n: number;
  base_rate?: number;
  auc?: number | null;
  logloss?: number;
  logloss_baseline?: number;
  logloss_skill?: number | null;
  brier?: number;
}

export interface OverallMetrics extends ClassificationMetrics {
  top_decile_hit_rate?: number;
  top_decile_net_return_pct?: number;
  mean_net_return_all_pct?: number;
}

export interface ModelMetrics {
  overall: OverallMetrics;
  oof_start: number;
  oof_end: number;
  folds: number;
  features: number;
  train_seconds: number;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ModelRun {
  id: string;
  name: string;
  job_id: string | null;
  status: RunStatus;
  params: ModelParams;
  metrics: ModelMetrics | null;
  created_at: number;
  job: Job | null;
}

export interface FoldReport extends ClassificationMetrics {
  index: number;
  train_start: number;
  train_end: number;
  valid_start: number;
  valid_end: number;
  test_start: number;
  test_end: number;
  train_rows: number;
  train_base_rate: number;
  best_rounds: number | null;
  top_decile_hit_rate: number | null;
  top_decile_net_return_pct: number | null;
}

export interface ImportanceRow {
  feature: string;
  importance: number;
}

export interface CalibrationBin {
  mean_prob: number;
  hit_rate: number;
  n: number;
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

export interface ThresholdRow {
  threshold: number;
  share: number;
  n: number;
  hit_rate: number | null;
  mean_net_return_pct: number | null;
}

export interface ModelRunDetail extends ModelRun {
  folds: FoldReport[] | null;
  importance: ImportanceRow[] | null;
  calibration: CalibrationBin[] | null;
  histogram: HistogramBin[] | null;
  thresholds: ThresholdRow[] | null;
}

// ---- Backtests --------------------------------------------------------------------------------

export type Sizing = 'compound' | 'fixed';

export interface BacktestRequest {
  name?: string;
  model_run_id: string;
  start_ts?: number;
  end_ts?: number;
  threshold: number;
  tp_pct?: number;
  sl_pct?: number;
  max_hold_minutes?: number;
  fee_pct: number;
  slippage_bps: number;
  latency_seconds?: number;
  initial_capital: number;
  sizing: Sizing;
  order_quote: number;
  compound_fraction: number;
  // Omitted = the traded coin's Binance filters.
  min_notional?: number;
  qty_step?: number;
  cooldown_minutes: number;
}

export interface SweepRequest extends BacktestRequest {
  thresholds: number[];
  tp_sl_pairs: Array<[number, number]>;
}

export interface BacktestParams {
  name: string;
  model_run_id: string;
  // Traded coin (absent on backtests created before multi-coin support).
  symbol?: string;
  start_ts: number | null;
  end_ts: number | null;
  threshold: number;
  tp_pct: number;
  sl_pct: number;
  max_hold_minutes: number;
  fee_pct: number;
  slippage_bps: number;
  latency_seconds: number;
  initial_capital: number;
  sizing: Sizing;
  order_quote: number;
  compound_fraction: number;
  min_notional: number;
  qty_step: number;
  cooldown_minutes: number;
  kind: 'single' | 'sweep';
  thresholds?: number[];
  tp_sl_pairs?: Array<[number, number]>;
}

export interface BacktestSummary {
  trades: number;
  skipped_below_min_notional: number;
  win_rate: number | null;
  net_pnl: number;
  return_pct: number;
  final_equity: number;
  fees_paid: number;
  profit_factor: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  expectancy_pct: number | null;
  max_drawdown_pct: number;
  sharpe: number | null;
  exposure_pct: number;
  avg_hold_minutes: number | null;
  trades_per_day: number;
  exits: { take_profit: number; stop_loss: number; timeout: number };
  start_ts: number;
  end_ts: number;
  vs_buy_and_hold_pct: number;
  random_mean_return_pct: number | null;
  random_percentile: number | null;
}

export interface SweepRow {
  threshold: number;
  tp_pct: number;
  sl_pct: number;
  trades: number;
  win_rate: number | null;
  return_pct: number;
  profit_factor: number | null;
  max_drawdown_pct: number;
  sharpe: number | null;
  fees_paid: number;
  trades_per_day: number;
}

export interface SweepSummary {
  combinations: number;
  best: SweepRow;
  start_ts: number;
  end_ts: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface RandomBaseline {
  runs: number;
  mean_return_pct?: number;
  std_return_pct?: number;
  p05_return_pct?: number;
  p95_return_pct?: number;
  mean_trades?: number;
  model_percentile?: number;
  returns?: number[];
}

export interface BuyAndHoldBaseline {
  return_pct: number;
  final_equity: number;
  max_drawdown_pct: number;
  curve: EquityPoint[];
}

export interface Baselines {
  random: RandomBaseline;
  buy_and_hold: BuyAndHoldBaseline;
}

export interface MonthlyReturn {
  month: string; // "YYYY-MM"
  return_pct: number;
}

export interface Backtest {
  id: string;
  name: string;
  model_run_id: string | null;
  job_id: string | null;
  status: RunStatus;
  params: BacktestParams;
  // A single run stores BacktestSummary, a sweep stores SweepSummary.
  summary: BacktestSummary | SweepSummary | null;
  created_at: number;
  job: Job | null;
}

export interface BacktestDetail extends Backtest {
  equity: EquityPoint[] | null;
  baselines: Baselines | null;
  monthly: MonthlyReturn[] | null;
  sweep: SweepRow[] | null;
}

// outcome: 1 = take profit, -1 = stop loss, 0 = timeout.
export interface Trade {
  entry_ts: number;
  exit_ts: number;
  entry_price: number;
  exit_price: number;
  quantity: number;
  pnl: number;
  fees: number;
  outcome: number;
  prob: number;
  equity_after: number;
}

export interface TradesResponse {
  total: number;
  trades: Trade[];
}
