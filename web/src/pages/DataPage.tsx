import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Database, Download, Hammer, Layers, ListTree, Plus, Search } from 'lucide-react';

import { JobProgress } from '../components/JobProgress';
import { Button, Card, EmptyState, Inset, KeyValue, Notice, SectionTitle, Skeleton, Stat, cx, inputClassName } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { buildMonthGrid, monthCellTone, type MonthCell, type MonthGrid as MonthGridData } from '../lib/coverage';
import { formatCompact, formatDate, formatDateTime, formatDuration, formatInteger, formatNumber, formatRatio } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { DEFAULT_CONTEXT, DEFAULT_TARGET, SYMBOL_PATTERN, normalizeSymbol, pairLabel, symbolsWithBars } from '../lib/symbols';
import type { FeatureMeta, FeatureSummary, JobKind, SymbolCoverage, SymbolInfo } from '../lib/types';
import { useAsync } from '../lib/useAsync';

const DATA_KINDS: JobKind[] = ['download', 'build_series', 'build_features'];

type StartAction =
  | { kind: 'download'; symbols: string[] }
  | { kind: 'build_series'; symbols: string[] }
  | { kind: 'build_features'; target: string; context: string | null };

export function DataPage() {
  const { active, settledVersion, refresh: refreshJobs } = useJobs();
  const status = useAsync(() => api.dataStatus(), [settledVersion]);
  const [starting, setStarting] = useState<JobKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const dataJobs = active.filter((job) => DATA_KINDS.includes(job.kind));
  const busy = (kind: JobKind) => starting === kind || dataJobs.some((job) => job.kind === kind);
  const otherActive = active.filter((job) => !DATA_KINDS.includes(job.kind));

  // Coverage changes while a data job runs (months appear one by one): refresh it periodically.
  const { reload } = status;
  useEffect(() => {
    if (dataJobs.length === 0) return;
    const id = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 5000);
    return () => window.clearInterval(id);
  }, [dataJobs.length, reload]);

  const start = async (action: StartAction) => {
    setStarting(action.kind);
    setActionError(null);
    try {
      if (action.kind === 'download') await api.startDownload(action.symbols);
      else if (action.kind === 'build_series') await api.startBuild(action.symbols);
      else await api.startFeatures(action.target, action.context);
      await refreshJobs();
      reload();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setStarting(null);
    }
  };

  const data = status.data;
  const symbols = data?.symbols ?? [];
  const allSymbols = symbols.map((item) => item.symbol);
  const downloadedSymbols = symbols.filter((item) => item.downloaded_months.length > 0).map((item) => item.symbol);
  const barSymbols = symbolsWithBars(symbols);

  return (
    <div className="space-y-4">
      <Card as="section" className="p-4 sm:p-5">
        <SectionTitle
          icon={Database}
          title="Data pipeline"
          description="Binance 1-second klines per coin: download, unpack into dense per-second series with 1m bars, then build a feature matrix for a traded coin with an optional context coin."
        />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <PipelineStep
            step={1}
            title="Download / update"
            detail={allSymbols.length ? `All coins: ${allSymbols.join(', ')}.` : 'Monthly archives plus daily files for the current month.'}
            icon={Download}
            busy={busy('download')}
            disabled={allSymbols.length === 0}
            primary
            onClick={() => void start({ kind: 'download', symbols: allSymbols })}
          />
          <PipelineStep
            step={2}
            title="Build series & 1m bars"
            detail={downloadedSymbols.length || !data ? 'Unpacks new months of every downloaded coin and rebuilds its 1m bars.' : 'Download data first.'}
            icon={Hammer}
            busy={busy('build_series')}
            disabled={Boolean(data) && downloadedSymbols.length === 0}
            onClick={() => void start({ kind: 'build_series', symbols: downloadedSymbols })}
          />
          <FeatureBuilder
            barSymbols={barSymbols}
            loaded={Boolean(data)}
            busy={busy('build_features')}
            onBuild={(target, context) => void start({ kind: 'build_features', target, context })}
          />
        </div>
        {actionError ? (
          <Notice tone="negative" icon={AlertTriangle} className="mt-3">
            {actionError}
          </Notice>
        ) : null}
        {dataJobs.length > 0 ? (
          <div className="mt-3 space-y-2">
            {dataJobs.map((job) => (
              <JobProgress key={job.id} job={job} />
            ))}
            {otherActive.length > 0 || dataJobs.length > 1 ? (
              <p className="text-xs text-fg-subtle">Jobs run one at a time; queued jobs start when the current one finishes.</p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <AddCoin known={allSymbols} downloading={busy('download')} onDownload={(symbol) => void start({ kind: 'download', symbols: [symbol] })} />

      {status.errorText && !data ? (
        <Notice tone="negative" icon={AlertTriangle}>
          Could not load data status: {status.errorText}
        </Notice>
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {data
          ? symbols.map((item) => (
              <SymbolCoverageCard
                key={item.symbol}
                coverage={item}
                downloadBusy={busy('download')}
                buildBusy={busy('build_series')}
                onDownload={() => void start({ kind: 'download', symbols: [item.symbol] })}
                onBuild={() => void start({ kind: 'build_series', symbols: [item.symbol] })}
              />
            ))
          : status.loading
            ? [0, 1].map((key) => (
                <Card key={key} className="space-y-3 p-4 sm:p-5">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-28 w-full" />
                </Card>
              ))
            : null}
      </div>

      {data ? <FeatureSets sets={data.features ?? []} /> : null}
    </div>
  );
}

function PipelineStep({
  step,
  title,
  detail,
  icon,
  busy,
  disabled,
  primary,
  onClick,
}: {
  step: number;
  title: string;
  detail: string;
  icon: typeof Download;
  busy: boolean;
  disabled?: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <Inset className="flex flex-col gap-3 p-3.5">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Step {step}</p>
        <p className="mt-0.5 text-sm font-semibold text-fg">{title}</p>
        <p className="mt-0.5 break-words text-sm text-fg-muted">{detail}</p>
      </div>
      <Button variant={primary ? 'primary' : 'secondary'} icon={icon} className="mt-auto w-full" disabled={busy || disabled} onClick={onClick}>
        {busy ? 'Running…' : title}
      </Button>
    </Inset>
  );
}

const NO_CONTEXT = 'none';

function FeatureBuilder({
  barSymbols,
  loaded,
  busy,
  onBuild,
}: {
  barSymbols: string[];
  loaded: boolean;
  busy: boolean;
  onBuild: (target: string, context: string | null) => void;
}) {
  const [target, setTarget] = useState('');
  const [context, setContext] = useState('');
  const barKey = barSymbols.join(',');

  // Default selection: SOLUSDT traded with BTCUSDT as context, when their bars exist.
  useEffect(() => {
    const available = barKey ? barKey.split(',') : [];
    if (available.length === 0) return;
    setTarget((current) =>
      current && available.includes(current) ? current : available.includes(DEFAULT_TARGET) ? DEFAULT_TARGET : available[0],
    );
  }, [barKey]);

  useEffect(() => {
    const available = barKey ? barKey.split(',') : [];
    if (available.length === 0) return;
    setContext((current) => {
      if (current === NO_CONTEXT) return current;
      if (current && current !== target && available.includes(current)) return current;
      const others = available.filter((symbol) => symbol !== target);
      return others.includes(DEFAULT_CONTEXT) ? DEFAULT_CONTEXT : (others[0] ?? NO_CONTEXT);
    });
  }, [target, barKey]);

  const ready = barSymbols.length > 0 && Boolean(target);

  return (
    <Inset className="flex flex-col gap-3 p-3.5">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Step 3</p>
        <p className="mt-0.5 text-sm font-semibold text-fg">Build features</p>
        <p className="mt-0.5 text-sm text-fg-muted">
          {ready || !loaded ? 'Returns, volatility, flow, cross-coin and calendar features on the 1m grid.' : 'Build 1m bars for a coin first.'}
        </p>
      </div>
      {ready ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className="mb-1 block text-xs text-fg-muted">Traded coin</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)} className={inputClassName}>
              {barSymbols.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs text-fg-muted">Context coin</span>
            <select value={context} onChange={(event) => setContext(event.target.value)} className={inputClassName}>
              <option value={NO_CONTEXT}>None</option>
              {barSymbols
                .filter((symbol) => symbol !== target)
                .map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ) : null}
      <Button icon={Layers} className="mt-auto w-full" disabled={busy || !ready} onClick={() => onBuild(target, context === NO_CONTEXT ? null : context)}>
        {busy ? 'Running…' : 'Build features'}
      </Button>
    </Inset>
  );
}

function AddCoin({ known, downloading, onDownload }: { known: string[]; downloading: boolean; onDownload: (symbol: string) => void }) {
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<SymbolInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const symbol = normalizeSymbol(text);
  const formatError = text.trim() && !SYMBOL_PATTERN.test(symbol) ? 'Use a Binance spot symbol such as ETHUSDT.' : null;

  const validate = async (event: FormEvent) => {
    event.preventDefault();
    if (!symbol || formatError) return;
    setChecking(true);
    setError(null);
    setInfo(null);
    try {
      setInfo(await api.validateSymbol(symbol));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  };

  const alreadyKnown = info ? known.includes(info.symbol) : false;

  return (
    <Card as="section" className="p-4 sm:p-5">
      <SectionTitle icon={Plus} title="Add coin" description="Any Binance spot pair with 1-second archives. Validation checks Binance's archive listing and trading filters." />
      <form className="mt-4 flex flex-wrap items-start gap-2" onSubmit={(event) => void validate(event)}>
        <label className="min-w-0 flex-1 basis-48">
          <span className="sr-only">Symbol</span>
          <input
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setInfo(null);
              setError(null);
            }}
            placeholder="e.g. ETHUSDT"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={Boolean(formatError)}
            className={cx(inputClassName, 'uppercase placeholder:normal-case', formatError && 'border-negative/70')}
          />
          {formatError ? <span className="mt-1 block text-xs text-negative">{formatError}</span> : null}
        </label>
        <Button type="submit" icon={Search} disabled={!symbol || Boolean(formatError) || checking}>
          {checking ? 'Checking…' : 'Validate'}
        </Button>
      </form>
      {error ? (
        <Notice tone="negative" icon={AlertTriangle} className="mt-3">
          {error}
        </Notice>
      ) : null}
      {info ? (
        info.valid ? (
          <Inset className="mt-3 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                <CheckCircle2 aria-hidden="true" strokeWidth={2} className="h-4 w-4 text-positive" />
                {info.symbol}
              </p>
              <Button variant="primary" icon={Download} disabled={downloading} onClick={() => onDownload(info.symbol)}>
                {downloading ? 'Download running…' : alreadyKnown ? `Update ${info.symbol}` : `Download ${info.symbol}`}
              </Button>
            </div>
            <div className="mt-2 grid gap-x-8 sm:grid-cols-2">
              <KeyValue label="1s history from" value={info.first_month ?? '—'} />
              <KeyValue label="Monthly archives" value={formatInteger(info.archive_months)} />
              <KeyValue label="Quantity step" value={info.qty_step === null ? '—' : String(info.qty_step)} />
              <KeyValue label="Min notional" value={info.min_notional === null ? '—' : `${formatNumber(info.min_notional, 2)} ${info.quote_asset ?? ''}`.trim()} />
            </div>
            {alreadyKnown ? <p className="mt-2 text-xs text-fg-subtle">Already on disk; downloading fetches only missing months.</p> : null}
            {info.quote_asset && info.quote_asset !== 'USDT' ? (
              <p className="mt-2 text-xs text-warning">Quote asset is {info.quote_asset}; backtest amounts are in {info.quote_asset}, not USDT.</p>
            ) : null}
          </Inset>
        ) : (
          <Notice tone="warning" icon={AlertTriangle} className="mt-3">
            Binance publishes no 1-second history for {info.symbol}.
          </Notice>
        )
      ) : null}
    </Card>
  );
}

function SymbolCoverageCard({
  coverage,
  downloadBusy,
  buildBusy,
  onDownload,
  onBuild,
}: {
  coverage: SymbolCoverage;
  downloadBusy: boolean;
  buildBusy: boolean;
  onDownload: () => void;
  onBuild: () => void;
}) {
  const grid = useMemo(() => buildMonthGrid(coverage), [coverage]);
  const storedSeconds = coverage.months.reduce((sum, month) => sum + (month.rows || 0), 0);
  const expected = storedSeconds + coverage.missing_seconds;
  const pendingBuild = coverage.downloaded_months.filter((month) => !coverage.built_months.includes(month)).length;

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        title={coverage.symbol}
        description={coverage.first_ts !== null ? `${formatDate(coverage.first_ts)} → ${formatDate(coverage.last_ts)} (UTC)` : 'No series built yet'}
        aside={
          <>
            <Button size="sm" icon={Download} disabled={downloadBusy} onClick={onDownload} title={`Download missing months of ${coverage.symbol}`}>
              Update
            </Button>
            <Button
              size="sm"
              icon={Hammer}
              disabled={buildBusy || coverage.downloaded_months.length === 0}
              onClick={onBuild}
              title={`Build ${coverage.symbol} series and 1m bars`}
            >
              Build
            </Button>
          </>
        }
      />
      <p className="mt-1 text-xs">
        {coverage.bars_built ? (
          <span className="text-fg-subtle">1m bars updated {formatDateTime(coverage.bars_updated_at)}</span>
        ) : (
          <span className="text-warning">1m bars not built</span>
        )}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat size="sm" label="Downloaded" value={`${coverage.downloaded_months.length} mo`} />
        <Stat
          size="sm"
          label="Built"
          value={`${coverage.built_months.length} mo`}
          tone={pendingBuild > 0 ? 'warning' : 'neutral'}
          detail={pendingBuild > 0 ? `${pendingBuild} to build` : undefined}
        />
        <Stat size="sm" label="Seconds stored" value={formatCompact(storedSeconds)} />
        <Stat
          size="sm"
          label="Missing seconds"
          value={formatCompact(coverage.missing_seconds)}
          detail={expected > 0 ? formatRatio(coverage.missing_seconds / expected, 3) : undefined}
          tone={expected > 0 && coverage.missing_seconds / expected > 0.01 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="mt-5">
        {grid.years.length === 0 ? (
          <EmptyState icon={Download} title="No months downloaded yet">
            Use “Update” to download this coin.
          </EmptyState>
        ) : (
          <MonthGrid grid={grid} />
        )}
      </div>
    </Card>
  );
}

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function MonthGrid({ grid }: { grid: MonthGridData }) {
  return (
    <div>
      <div className="grid grid-cols-[2.75rem_repeat(12,minmax(0,1fr))] gap-1 text-[11px] text-fg-subtle">
        <span />
        {MONTH_LABELS.map((label, index) => (
          <span key={index} className="text-center">
            {label}
          </span>
        ))}
        {grid.years.map((year) => (
          <MonthRow key={year.year} year={year.year} cells={year.cells} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-muted">
        <LegendSwatch className="bg-positive/70" label="< 0.1% missing" />
        <LegendSwatch className="bg-warning/70" label="0.1–2% missing" />
        <LegendSwatch className="bg-negative/70" label="> 2% missing" />
        <LegendSwatch className="bg-fg-subtle/40" label="Downloaded, not built" />
        <LegendSwatch className="border border-dashed border-line-strong bg-transparent" label="Not downloaded" />
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="relative h-3 w-3 rounded-sm bg-positive/70">
            <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-fg" />
          </span>
          Partial (daily files)
        </span>
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cx('h-3 w-3 rounded-sm', className)} />
      {label}
    </span>
  );
}

const CELL_TONE: Record<ReturnType<typeof monthCellTone>, string> = {
  ok: 'bg-positive/70',
  minor: 'bg-warning/70',
  major: 'bg-negative/70',
  pending: 'bg-fg-subtle/40',
  absent: 'border border-dashed border-line-strong',
  future: 'bg-transparent',
};

function MonthRow({ year, cells }: { year: number; cells: MonthCell[] }) {
  return (
    <>
      <span className="self-center tabular-nums text-fg-muted">{year}</span>
      {cells.map((cell) => {
        const tone = monthCellTone(cell);
        return (
          <span
            key={cell.month}
            title={cell.tooltip}
            aria-label={cell.tooltip}
            className={cx('relative h-6 rounded-sm transition-opacity hover:opacity-80', CELL_TONE[tone])}
          >
            {cell.info?.partial ? <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-fg" /> : null}
          </span>
        );
      })}
    </>
  );
}

function FeatureSets({ sets }: { sets: FeatureSummary[] }) {
  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle icon={Layers} title="Feature sets" description="One matrix per traded coin and context coin. Training builds a missing one automatically." />
      <div className="mt-4">
        {sets.length === 0 ? (
          <EmptyState icon={Layers} title="No feature sets built yet">
            Build one in step 3 above once a coin has 1m bars.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {sets.map((set, index) => (
              <FeatureSetRow key={set.target ? `${set.target}-${set.context ?? NO_CONTEXT}` : `legacy-${index}`} set={set} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function FeatureSetRow({ set }: { set: FeatureSummary }) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<FeatureMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const target = set.target ?? null;
  const context = set.context ?? null;

  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setError(null);
    api
      .features(target, context)
      .then((value) => {
        if (!cancelled) setMeta(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, context, set.built_at]);

  const columns = meta?.columns ?? [];
  const filtered = filter ? columns.filter((column) => column.toLowerCase().includes(filter.toLowerCase())) : columns;

  return (
    <li className="bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-3 text-left hover:bg-surface-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            aria-hidden="true"
            strokeWidth={2}
            className={cx('h-4 w-4 shrink-0 text-fg-subtle transition-transform group-hover:text-fg', open && 'rotate-90')}
          />
          <ListTree aria-hidden="true" strokeWidth={2} className="h-4 w-4 shrink-0 text-fg-muted" />
          <span className="truncate text-sm font-semibold text-fg">{target ? pairLabel(target, context) : 'Legacy set (no coin info)'}</span>
        </span>
        <span className="text-xs tabular-nums text-fg-muted">
          {formatInteger(set.feature_count)} features × {formatInteger(set.rows)} minutes
        </span>
        <span className="text-xs tabular-nums text-fg-subtle sm:ml-auto">
          {formatDate(set.first_ts)} → {formatDate(set.last_ts)} · built {formatDateTime(set.built_at)}
        </span>
      </button>
      {open ? (
        <div className="border-t border-line px-3.5 py-3">
          <div className="grid gap-x-8 sm:grid-cols-2">
            <KeyValue label="Feature set" value={set.feature_set} />
            <KeyValue label="Build time" value={formatDuration(set.build_seconds)} />
          </div>
          <div className="mt-3">
            {!target ? (
              <p className="text-sm text-fg-muted">Built before multi-coin support; no model uses it. It can be deleted from the data folder.</p>
            ) : error ? (
              <Notice tone="negative" icon={AlertTriangle}>
                {error}
              </Notice>
            ) : !meta ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter features (e.g. ctx_, rv)"
                  aria-label="Filter features"
                  className={cx(inputClassName, 'max-w-sm')}
                />
                <p className="mt-2 text-xs text-fg-subtle">
                  {filtered.length} of {columns.length} shown. Prefixes: target_ traded coin, ctx_ context coin, x_ cross-coin, cal_ calendar.
                </p>
                <ul className="mt-2 grid max-h-80 gap-x-4 overflow-auto rounded-lg border border-line p-2 font-mono text-xs text-fg-muted sm:grid-cols-2 lg:grid-cols-3">
                  {filtered.map((column) => (
                    <li key={column} className="truncate py-0.5" title={column}>
                      {column}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
