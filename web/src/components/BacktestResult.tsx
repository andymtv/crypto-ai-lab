import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CandlestickChart, ChevronLeft, ChevronRight, LineChart, Scale, Table2, TrendingUp, Upload } from 'lucide-react';

import { api, errorMessage, isNotFound } from '../lib/api';
import { baseAsset } from '../lib/symbols';
import { pickTimeframe, TIMEFRAME_SECONDS, toLineData, tradeMarkers, outcomeLabel } from '../lib/chartData';
import {
  finite,
  formatDate,
  formatDateTime,
  formatInteger,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatProbability,
  formatRatio,
  signTone,
} from '../lib/format';
import { effectiveStatus, isActiveStatus, useJobs, useLiveJob } from '../lib/jobs';
import type {
  BacktestDetail,
  BacktestParams,
  BacktestSummary,
  Baselines,
  Candle,
  MonthlyReturn,
  SweepRow,
  SweepSummary,
  Timeframe,
  Trade,
} from '../lib/types';
import { useChartPalette } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { JobProgress } from './JobProgress';
import { RandomBaselineStrip } from './SvgCharts';
import { CandleChart, LineOverlayChart, type LineSpec } from './TimeCharts';
import { Badge, Button, Card, EmptyState, Inset, Notice, SectionTitle, Skeleton, Stat, StatusBadge, TABLE_CELL, TABLE_HEAD_CELL, cx, toneText, type Tone } from './ui';

export function isSweepSummary(summary: BacktestDetail['summary']): summary is SweepSummary {
  return Boolean(summary && 'combinations' in summary);
}

export function BacktestResult({
  id,
  symbolForModel,
  onLoadSettings,
  onApplySweepRow,
}: {
  id: string;
  // Traded coin of a model run, for backtests saved before params carried `symbol`.
  symbolForModel: (modelRunId: string | null) => string | null;
  onLoadSettings: (params: BacktestParams) => void;
  onApplySweepRow: (params: BacktestParams, row: SweepRow) => void;
}) {
  const { settledVersion } = useJobs();
  const record = useAsync(() => api.backtest(id), [id, settledVersion]);

  if (record.error && isNotFound(record.error)) {
    return (
      <Card className="p-4 sm:p-5">
        <EmptyState icon={AlertTriangle} title="Backtest not found">
          It may have been deleted.
        </EmptyState>
      </Card>
    );
  }
  if (record.errorText && !record.data) {
    return (
      <Notice tone="negative" icon={AlertTriangle}>
        Could not load the backtest: {record.errorText}
      </Notice>
    );
  }
  if (!record.data || record.data.id !== id) {
    return (
      <Card className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </Card>
    );
  }
  const symbol = record.data.params.symbol ?? symbolForModel(record.data.model_run_id);
  return <BacktestView detail={record.data} symbol={symbol} onLoadSettings={onLoadSettings} onApplySweepRow={onApplySweepRow} />;
}

function BacktestView({
  detail,
  symbol,
  onLoadSettings,
  onApplySweepRow,
}: {
  detail: BacktestDetail;
  symbol: string | null;
  onLoadSettings: (params: BacktestParams) => void;
  onApplySweepRow: (params: BacktestParams, row: SweepRow) => void;
}) {
  const job = useLiveJob(detail.job);
  const status = effectiveStatus(detail.status, job);
  const params = detail.params;
  const isSweep = params.kind === 'sweep';
  const summary = detail.summary;

  return (
    <div className="min-w-0 space-y-4">
      <Card as="section" className="min-w-0 p-4 sm:p-5">
        <SectionTitle
          icon={isSweep ? Table2 : TrendingUp}
          title={
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate">{detail.name}</span>
              <StatusBadge status={status} progress={job?.progress} />
              {symbol ? <Badge>{symbol}</Badge> : null}
              {isSweep ? <Badge tone="accent">sweep</Badge> : null}
            </span>
          }
          description={describeParams(params)}
          aside={
            <Button size="sm" icon={Upload} onClick={() => onLoadSettings(params)}>
              Load settings
            </Button>
          }
        />
        {job && (isActiveStatus(job.status) || job.status === 'failed' || job.status === 'cancelled') ? (
          <JobProgress job={job} className="mt-4" />
        ) : null}
        {!isSweep && summary && !isSweepSummary(summary) ? <SummaryGrid summary={summary} params={params} /> : null}
      </Card>

      {status === 'done' && !isSweep && summary && !isSweepSummary(summary) ? <SingleResults detail={detail} summary={summary} symbol={symbol} /> : null}
      {status === 'done' && isSweep ? <SweepResults detail={detail} onApply={(row) => onApplySweepRow(params, row)} /> : null}
    </div>
  );
}

function describeParams(params: BacktestParams): string {
  const sizing =
    params.sizing === 'compound'
      ? `compound ${formatNumber(params.compound_fraction * 100, 0)}%`
      : `fixed ${formatMoney(params.order_quote)} USDT`;
  const signal = params.kind === 'sweep' ? `${params.thresholds?.length ?? 0} thresholds × ${params.tp_sl_pairs?.length ?? 0} TP/SL` : `p ≥ ${params.threshold} · TP ${params.tp_pct}% / SL ${params.sl_pct}%`;
  return `${signal} · hold ≤ ${params.max_hold_minutes}m · fee ${params.fee_pct}% · slip ${params.slippage_bps}bps · ${formatMoney(params.initial_capital)} USDT ${sizing}`;
}

// ---- Summary cards ----------------------------------------------------------------------------

function SummaryGrid({ summary, params }: { summary: BacktestSummary; params: BacktestParams }) {
  const exits = summary.exits ?? { take_profit: 0, stop_loss: 0, timeout: 0 };
  const totalExits = exits.take_profit + exits.stop_loss + exits.timeout;

  return (
    <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      <Tile label="Return" value={formatPercent(summary.return_pct, 2, { sign: true })} tone={signTone(summary.return_pct)} detail={`${formatDate(summary.start_ts)} → ${formatDate(summary.end_ts)}`} />
      <Tile
        label="Net PnL"
        value={formatMoney(summary.net_pnl, { sign: true })}
        tone={signTone(summary.net_pnl)}
        detail={`${formatMoney(params.initial_capital)} → ${formatMoney(summary.final_equity)} USDT`}
      />
      <Tile label="Trades" value={formatInteger(summary.trades)} detail={`${formatNumber(summary.trades_per_day, 2)} / day`} />
      <Tile label="Win rate" value={formatRatio(summary.win_rate)} detail={`avg hold ${formatNumber(summary.avg_hold_minutes, 1)}m`} />
      <Tile label="Profit factor" value={formatNumber(summary.profit_factor, 2)} tone={summary.profit_factor == null ? 'neutral' : summary.profit_factor >= 1 ? 'positive' : 'negative'} />
      <Tile label="Max DD" value={formatPercent(summary.max_drawdown_pct, 2)} tone={finite(summary.max_drawdown_pct) !== null && summary.max_drawdown_pct < -0.005 ? 'negative' : 'neutral'} />
      <Tile label="Sharpe" detail="daily, annualized" value={formatNumber(summary.sharpe, 2)} tone={signTone(summary.sharpe)} />
      <Tile label="Fees paid" value={formatMoney(summary.fees_paid)} detail="quote currency" />
      <Tile label="Exposure" value={formatPercent(summary.exposure_pct, 1)} detail="time in a position" />
      <Tile label="Expectancy" value={formatPercent(summary.expectancy_pct, 3, { sign: true })} tone={signTone(summary.expectancy_pct)} detail="per trade after fees" />
      <Inset className="col-span-2 min-w-0 px-3 py-2.5">
        <p className="text-sm text-fg-muted">Exits</p>
        <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-surface-3">
          {totalExits > 0 ? (
            <>
              <span className="bg-positive" style={{ width: `${(exits.take_profit / totalExits) * 100}%` }} />
              <span className="bg-negative" style={{ width: `${(exits.stop_loss / totalExits) * 100}%` }} />
              <span className="bg-warning" style={{ width: `${(exits.timeout / totalExits) * 100}%` }} />
            </>
          ) : null}
        </div>
        <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-fg-muted">
          <span>
            <span className="text-positive">TP</span> {formatInteger(exits.take_profit)}
          </span>
          <span>
            <span className="text-negative">SL</span> {formatInteger(exits.stop_loss)}
          </span>
          <span>
            <span className="text-warning">Timeout</span> {formatInteger(exits.timeout)}
          </span>
          {summary.skipped_below_min_notional > 0 ? (
            <span className="text-warning">{formatInteger(summary.skipped_below_min_notional)} skipped &lt; min notional</span>
          ) : (
            <span>0 skipped &lt; min notional</span>
          )}
        </p>
      </Inset>
    </div>
  );
}

function Tile({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail?: string; tone?: Tone }) {
  return (
    <Inset className="min-w-0 px-3 py-2.5">
      <Stat size="sm" label={label} value={value} detail={detail} tone={tone} />
    </Inset>
  );
}

// ---- Single-run results -----------------------------------------------------------------------

function SingleResults({ detail, summary, symbol }: { detail: BacktestDetail; summary: BacktestSummary; symbol: string | null }) {
  const coin = symbol ? baseAsset(symbol) : 'the coin';
  const trades = useAsync(() => api.trades(detail.id), [detail.id]);
  const tradeList = trades.data?.trades ?? null;

  return (
    <>
      {detail.baselines ? <Baselines baselines={detail.baselines} summary={summary} coin={coin} /> : null}

      <Card as="section" className="min-w-0 p-4 sm:p-5">
        <SectionTitle icon={LineChart} title="Equity" description={`Strategy equity after each closed trade vs buying and holding ${coin} (daily, incl. fees).`} />
        <EquityLegend />
        <div className="mt-3">
          <EquityChart detail={detail} />
        </div>
      </Card>

      <PricePanel symbol={symbol} summary={summary} trades={tradeList} tradesTotal={trades.data?.total ?? null} tradesError={trades.errorText} />

      {detail.monthly && detail.monthly.length > 0 ? <MonthlyHeatmap months={detail.monthly} /> : null}

      <TradesTable trades={tradeList} total={trades.data?.total ?? null} loading={trades.loading && !trades.data} error={trades.errorText} />
    </>
  );
}

export function LegendLine({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cx('h-0 w-4 border-t-2', dashed && 'border-dashed')} style={{ borderColor: color }} />
      {label}
    </span>
  );
}

function EquityLegend() {
  const palette = useChartPalette();
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
      <LegendLine color={palette.series[0]} label="Strategy" />
      <LegendLine color={palette.series[2]} label="Buy & hold" dashed />
    </div>
  );
}

function EquityChart({ detail }: { detail: BacktestDetail }) {
  const lines = useMemo<LineSpec[]>(() => {
    const result: LineSpec[] = [
      { id: 'strategy', label: 'Strategy', colorIndex: 0, data: toLineData(detail.equity, (p) => p.t, (p) => p.equity) },
    ];
    const curve = detail.baselines?.buy_and_hold?.curve;
    if (curve && curve.length > 0) {
      result.push({ id: 'hold', label: 'Buy & hold', colorIndex: 2, dashed: true, data: toLineData(curve, (p) => p.t, (p) => p.equity) });
    }
    return result;
  }, [detail]);

  if (lines.every((line) => line.data.length === 0)) {
    return <EmptyState title="No equity data" />;
  }
  return <LineOverlayChart lines={lines} height={300} precision={2} />;
}

// ---- Baselines --------------------------------------------------------------------------------

function Baselines({ baselines, summary, coin }: { baselines: Baselines; summary: BacktestSummary; coin: string }) {
  const hold = baselines.buy_and_hold;
  const random = baselines.random;
  const vsHold = finite(summary.return_pct) !== null && hold ? summary.return_pct - hold.return_pct : null;
  const percentile = finite(random.model_percentile);
  const randomVerdict: { tone: Tone; text: string } =
    random.runs === 0 || percentile === null
      ? { tone: 'neutral', text: 'The model made no trades, so there is no random-timing comparison.' }
      : percentile >= 95
        ? { tone: 'positive', text: `Beats ${formatNumber(percentile, 0)}% of random-timing runs: the signal's timing carries information.` }
        : percentile >= 50
          ? { tone: 'warning', text: `Beats ${formatNumber(percentile, 0)}% of random-timing runs: not clearly better than luck.` }
          : { tone: 'negative', text: `Beats only ${formatNumber(percentile, 0)}% of random-timing runs: worse than random timing.` };

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle icon={Scale} title="Does the model beat the baselines?" />
      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
        <Inset className="min-w-0 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-fg">vs buy &amp; hold {coin}</p>
            {vsHold !== null ? (
              <Badge tone={vsHold > 0 ? 'positive' : 'negative'}>
                {vsHold > 0 ? 'Beats' : 'Trails'} by {formatNumber(Math.abs(vsHold), 2)} pp
              </Badge>
            ) : null}
          </div>
          <div className="relative mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="py-1 text-left font-medium text-fg-muted" />
                  <th className="py-1 text-right font-medium text-fg-muted">Return</th>
                  <th className="py-1 text-right font-medium text-fg-muted">Max DD</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                <tr>
                  <td className="py-1 text-fg">Model</td>
                  <td className={cx('py-1 text-right font-medium', toneText(signTone(summary.return_pct)))}>{formatPercent(summary.return_pct, 2, { sign: true })}</td>
                  <td className="py-1 text-right text-fg">{formatPercent(summary.max_drawdown_pct, 2)}</td>
                </tr>
                <tr>
                  <td className="py-1 text-fg">Buy &amp; hold</td>
                  <td className={cx('py-1 text-right font-medium', toneText(signTone(hold?.return_pct)))}>{formatPercent(hold?.return_pct, 2, { sign: true })}</td>
                  <td className="py-1 text-right text-fg">{formatPercent(hold?.max_drawdown_pct, 2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Inset>

        <Inset className="min-w-0 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-fg">vs random timing (same trades)</p>
            {percentile !== null && random.runs > 0 ? (
              <Badge tone={randomVerdict.tone}>beats {formatNumber(percentile, 0)}%</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-fg-muted">
            {random.runs} runs that shuffle the model's waiting times between trades: same number of trades and time in the market, same exits,
            sizing and costs. Only the entry timing is random.
          </p>
          {random.runs > 0 ? (
            <>
              <div className="mt-2 grid grid-cols-3 gap-2 text-sm tabular-nums">
                <div>
                  <p className="text-xs text-fg-muted">Mean ± std</p>
                  <p className="font-medium text-fg">
                    {formatPercent(random.mean_return_pct, 1, { sign: true })} ± {formatNumber(random.std_return_pct, 1)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">p05 … p95</p>
                  <p className="font-medium text-fg">
                    {formatPercent(random.p05_return_pct, 1)} … {formatPercent(random.p95_return_pct, 1)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">Mean trades</p>
                  <p className="font-medium text-fg">{formatNumber(random.mean_trades, 0)}</p>
                </div>
              </div>
              {random.returns && random.returns.length > 0 ? (
                <div className="mt-2">
                  <RandomBaselineStrip returns={random.returns} modelReturn={finite(summary.return_pct)} />
                </div>
              ) : null}
            </>
          ) : null}
          <Notice tone={randomVerdict.tone} className="mt-2">
            {randomVerdict.text}
          </Notice>
        </Inset>
      </div>
    </Card>
  );
}

// ---- Price chart with trade markers -----------------------------------------------------------

const MAX_MARKER_TRADES = 300;

function PricePanel({
  symbol,
  summary,
  trades,
  tradesTotal,
  tradesError,
}: {
  symbol: string | null;
  summary: BacktestSummary;
  trades: Trade[] | null;
  tradesTotal: number | null;
  tradesError: string | null;
}) {
  const start = summary.start_ts;
  const end = summary.end_ts;
  const autoTf = pickTimeframe(start, end);
  const [tf, setTf] = useState<Timeframe>(autoTf);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTf(autoTf), [autoTf]);

  useEffect(() => {
    let cancelled = false;
    setCandles(null);
    setError(null);
    if (!symbol) {
      setError('Unknown traded coin for this backtest.');
      return;
    }
    api
      .candles(symbol, tf, start, end)
      .then((response) => {
        if (!cancelled) setCandles(response.candles);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, start, end]);

  const { markers, shownTrades } = useMemo(
    () => (trades ? tradeMarkers(trades, TIMEFRAME_SECONDS[tf], MAX_MARKER_TRADES) : { markers: [], shownTrades: 0 }),
    [trades, tf],
  );
  const options = (['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]).filter((option) => (end - start) / TIMEFRAME_SECONDS[option] <= 5000);
  const totalTrades = tradesTotal ?? trades?.length ?? 0;

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={CandlestickChart}
        title={`${symbol ?? 'Price'} & trades`}
        description={
          totalTrades > shownTrades
            ? `Markers for the last ${formatInteger(shownTrades)} of ${formatInteger(totalTrades)} trades.`
            : 'Entries ▲, exits ▼ colored by outcome.'
        }
        aside={
          <div role="radiogroup" aria-label="Timeframe" className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={tf === option}
                onClick={() => setTf(option)}
                className={cx(
                  'h-9 rounded-md px-2.5 text-xs font-medium tabular-nums transition-colors sm:h-7',
                  tf === option ? 'bg-surface-3 text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="text-accent-fg">▲ entry</span>
        <span className="text-positive">▼ take profit</span>
        <span className="text-negative">▼ stop loss</span>
        <span className="text-warning">▼ timeout</span>
      </div>
      <div className="mt-3">
        {error ? (
          <EmptyState icon={CandlestickChart} title="No price data">
            {error}
          </EmptyState>
        ) : candles === null ? (
          <Skeleton className="h-[340px] w-full" />
        ) : candles.length === 0 ? (
          <EmptyState icon={CandlestickChart} title="No candles in this range" />
        ) : (
          <CandleChart candles={candles} markers={markers} />
        )}
        {tradesError ? <p className="mt-2 text-xs text-negative">Trades: {tradesError}</p> : null}
      </div>
    </Card>
  );
}

// ---- Monthly returns heatmap ------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function MonthlyHeatmap({ months }: { months: MonthlyReturn[] }) {
  const byYear = new Map<number, Map<number, number | null>>();
  for (const entry of months) {
    const [year, month] = entry.month.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
    if (!byYear.has(year)) byYear.set(year, new Map());
    byYear.get(year)!.set(month, finite(entry.return_pct));
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const maxAbs = Math.max(1e-9, ...months.map((entry) => Math.abs(finite(entry.return_pct) ?? 0)));
  const yearTotal = (year: number) => {
    const values = [...(byYear.get(year)?.values() ?? [])].filter((value): value is number => value !== null);
    return values.length ? (values.reduce((product, value) => product * (1 + value / 100), 1) - 1) * 100 : null;
  };

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle icon={CalendarDays} title="Monthly returns" description="Strategy equity change per calendar month (UTC)." />
      <div className="relative mt-4 overflow-x-auto">
        <div className="grid min-w-[340px] grid-cols-[2.75rem_repeat(12,minmax(0,1fr))_3.5rem] gap-1 text-[11px] tabular-nums">
          <span />
          {MONTH_NAMES.map((name) => (
            <span key={name} className="text-center text-fg-subtle">
              <span className="sm:hidden">{name[0]}</span>
              <span className="hidden sm:inline">{name}</span>
            </span>
          ))}
          <span className="text-right text-fg-subtle">Year</span>
          {years.map((year) => {
            const total = yearTotal(year);
            return [
              <span key={`${year}-label`} className="self-center text-fg-muted">
                {year}
              </span>,
              ...MONTH_NAMES.map((name, index) => {
                const value = byYear.get(year)?.get(index + 1);
                const has = value !== undefined && value !== null;
                const strength = has ? 12 + Math.round((Math.abs(value) / maxAbs) * 60) : 0;
                const color = has ? (value >= 0 ? 'var(--color-positive)' : 'var(--color-negative)') : 'transparent';
                return (
                  <span
                    key={`${year}-${name}`}
                    title={has ? `${name} ${year}: ${formatPercent(value, 2, { sign: true })}` : `${name} ${year}: no data`}
                    className={cx('flex h-8 items-center justify-center rounded-sm text-fg', !has && 'border border-dashed border-line')}
                    style={has ? { background: `color-mix(in srgb, ${color} ${strength}%, transparent)` } : undefined}
                  >
                    <span className="hidden md:inline">{has ? formatNumber(value, 1) : ''}</span>
                  </span>
                );
              }),
              <span key={`${year}-total`} className={cx('self-center text-right font-medium', toneText(signTone(total)))}>
                {formatPercent(total, 1, { sign: true })}
              </span>,
            ];
          })}
        </div>
      </div>
    </Card>
  );
}

// ---- Trades table -----------------------------------------------------------------------------

const PAGE_SIZE = 50;

function TradesTable({ trades, total, loading, error }: { trades: Trade[] | null; total: number | null; loading: boolean; error: string | null }) {
  const [page, setPage] = useState(0);
  const newestFirst = useMemo(() => (trades ? [...trades].sort((a, b) => b.entry_ts - a.entry_ts) : []), [trades]);
  const pages = Math.max(1, Math.ceil(newestFirst.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = newestFirst.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={Table2}
        title="Trades"
        description={
          total !== null && trades && total > trades.length
            ? `Newest first. Showing the last ${formatInteger(trades.length)} of ${formatInteger(total)}.`
            : 'Newest first.'
        }
        aside={
          newestFirst.length > PAGE_SIZE ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={ChevronLeft} aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)} />
              <span className="text-xs tabular-nums text-fg-muted">
                {current + 1} / {pages}
              </span>
              <Button size="sm" variant="ghost" icon={ChevronRight} aria-label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} />
            </div>
          ) : null
        }
      />
      <div className="mt-4">
        {error && !trades ? (
          <Notice tone={isNotFoundText(error) ? 'neutral' : 'negative'} icon={AlertTriangle}>
            {error}
          </Notice>
        ) : loading ? (
          <Skeleton className="h-40 w-full" />
        ) : newestFirst.length === 0 ? (
          <EmptyState title="No trades">The model never crossed the threshold with a valid order in this period.</EmptyState>
        ) : (
          <div className="relative overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className={TABLE_HEAD_CELL}>Entry (UTC)</th>
                  <th className={TABLE_HEAD_CELL}>Exit (UTC)</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Entry</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Exit</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Qty</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>PnL</th>
                  <th className={TABLE_HEAD_CELL}>Outcome</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Prob</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Equity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((trade, index) => (
                  <tr key={`${trade.entry_ts}-${index}`} className="hover:bg-surface-2">
                    <td className={cx(TABLE_CELL, 'whitespace-nowrap text-fg-muted')}>{formatDateTime(trade.entry_ts)}</td>
                    <td className={cx(TABLE_CELL, 'whitespace-nowrap text-fg-muted')}>{formatDateTime(trade.exit_ts)}</td>
                    <td className={cx(TABLE_CELL, 'text-right')}>{formatPrice(trade.entry_price)}</td>
                    <td className={cx(TABLE_CELL, 'text-right')}>{formatPrice(trade.exit_price)}</td>
                    <td className={cx(TABLE_CELL, 'text-right')}>{formatNumber(trade.quantity, 3)}</td>
                    <td className={cx(TABLE_CELL, 'text-right font-medium', toneText(signTone(trade.pnl)))}>{formatMoney(trade.pnl, { sign: true })}</td>
                    <td className={TABLE_CELL}>
                      <Badge tone={trade.outcome === 1 ? 'positive' : trade.outcome === -1 ? 'negative' : 'warning'}>{outcomeLabel(trade.outcome)}</Badge>
                    </td>
                    <td className={cx(TABLE_CELL, 'text-right')}>{formatProbability(trade.prob)}</td>
                    <td className={cx(TABLE_CELL, 'text-right')}>{formatMoney(trade.equity_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function isNotFoundText(text: string) {
  return /no trades/i.test(text);
}

// ---- Sweep results ----------------------------------------------------------------------------

type SweepSortKey = 'return_pct' | 'sharpe' | 'profit_factor' | 'max_drawdown_pct' | 'trades';

function SweepResults({ detail, onApply }: { detail: BacktestDetail; onApply: (row: SweepRow) => void }) {
  const rows = detail.sweep ?? [];
  const [sortKey, setSortKey] = useState<SweepSortKey>('return_pct');
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (finite(b[sortKey]) ?? -Infinity) - (finite(a[sortKey]) ?? -Infinity)),
    [rows, sortKey],
  );
  const thresholds = [...new Set(rows.map((row) => row.threshold))].sort((a, b) => a - b);
  const pairs = [...new Set(rows.map((row) => `${row.tp_pct}/${row.sl_pct}`))];
  const maxAbs = Math.max(1e-9, ...rows.map((row) => Math.abs(finite(row.return_pct) ?? 0)));
  const cellStyle = (value: number | null) => {
    if (value === null) return undefined;
    const strength = 10 + Math.round((Math.abs(value) / maxAbs) * 55);
    return { background: `color-mix(in srgb, ${value >= 0 ? 'var(--color-positive)' : 'var(--color-negative)'} ${strength}%, transparent)` };
  };

  if (rows.length === 0) {
    return (
      <Card className="p-4 sm:p-5">
        <EmptyState title="No sweep results" />
      </Card>
    );
  }

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle icon={Table2} title="Sweep results" description={`${rows.length} combinations on the same period.`} />
      <Notice tone="warning" icon={AlertTriangle} className="mt-3">
        Picking the best combination on the same period it was measured on overfits: the top row is partly luck. Check a chosen setting on a
        different period (or a later model) before trusting it, and prefer broad plateaus over a single peak.
      </Notice>

      {thresholds.length > 1 && pairs.length > 1 ? (
        <div className="relative mt-4 overflow-x-auto">
          <p className="mb-1.5 text-xs font-medium text-fg-muted">Return % by threshold (rows) × TP/SL (columns)</p>
          <table className="text-xs tabular-nums">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-medium text-fg-subtle">p ≥</th>
                {pairs.map((pair) => (
                  <th key={pair} className="whitespace-nowrap px-2 py-1 text-center font-medium text-fg-subtle">
                    {pair}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {thresholds.map((threshold) => (
                <tr key={threshold}>
                  <td className="px-2 py-1 text-fg-muted">{formatProbability(threshold, 2)}</td>
                  {pairs.map((pair) => {
                    const row = rows.find((candidate) => candidate.threshold === threshold && `${candidate.tp_pct}/${candidate.sl_pct}` === pair);
                    const value = row ? finite(row.return_pct) : null;
                    return (
                      <td key={pair} className="p-0.5">
                        <span
                          className="flex h-8 min-w-[4rem] items-center justify-center rounded-sm text-fg"
                          style={cellStyle(value)}
                          title={row ? `p ≥ ${threshold}, TP/SL ${pair}: ${formatPercent(value, 2, { sign: true })}, ${row.trades} trades` : 'n/a'}
                        >
                          {formatPercent(value, 1, { sign: true })}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-fg-muted">Sort by</span>
        <select
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SweepSortKey)}
          className="h-9 rounded-lg border border-line-strong bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent/70"
        >
          <option value="return_pct">Return</option>
          <option value="sharpe">Sharpe</option>
          <option value="profit_factor">Profit factor</option>
          <option value="max_drawdown_pct">Max drawdown (shallowest)</option>
          <option value="trades">Trades</option>
        </select>
      </div>
      <div className="relative mt-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className={TABLE_HEAD_CELL}>Threshold</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>TP / SL</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Return</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Trades</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Win rate</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>PF</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Max DD</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Sharpe</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Fees</th>
              <th className={TABLE_HEAD_CELL}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={`${row.threshold}-${row.tp_pct}-${row.sl_pct}`} className="hover:bg-surface-2">
                <td className={TABLE_CELL}>≥ {formatProbability(row.threshold, 2)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>
                  {row.tp_pct}% / {row.sl_pct}%
                </td>
                <td className={cx(TABLE_CELL, 'text-right font-medium')}>
                  <span className="rounded px-1.5 py-0.5" style={cellStyle(finite(row.return_pct))}>
                    {formatPercent(row.return_pct, 2, { sign: true })}
                  </span>
                </td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatInteger(row.trades)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatRatio(row.win_rate)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatNumber(row.profit_factor, 2)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatPercent(row.max_drawdown_pct, 1)}</td>
                <td className={cx(TABLE_CELL, 'text-right', toneText(signTone(row.sharpe)))}>{formatNumber(row.sharpe, 2)}</td>
                <td className={cx(TABLE_CELL, 'text-right text-fg-muted')}>{formatMoney(row.fees_paid)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>
                  <Button size="sm" variant="ghost" onClick={() => onApply(row)}>
                    Use
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
