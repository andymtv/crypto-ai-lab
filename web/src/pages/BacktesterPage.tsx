import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Brain, Columns3, FlaskConical, History, Info, Play, Grid3x3, Trash2 } from 'lucide-react';

import { BacktestResult, LegendLine, isSweepSummary } from '../components/BacktestResult';
import { NumberField, TextField } from '../components/FormFields';
import { LineOverlayChart, type LineSpec } from '../components/TimeCharts';
import { Button, Card, ChoiceCard, Collapsible, EmptyState, Notice, SectionTitle, Skeleton, StatusBadge, TABLE_CELL, TABLE_HEAD_CELL, cx, inputClassName, toneText } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import {
  buildSweepRequest,
  emptyBacktestForm,
  formDefaultsForModel,
  formFromParams,
  parseNumber,
  thresholdRowFor,
  validateBacktestForm,
  type BacktestFormState,
  type FormIssue,
} from '../lib/backtestForm';
import { toLineData } from '../lib/chartData';
import { formatAge, formatDate, formatInteger, formatNumber, formatPercent, formatProbability, formatRatio, signTone } from '../lib/format';
import { effectiveStatus, useJobs, useLiveJob } from '../lib/jobs';
import { useChartPalette } from '../lib/theme';
import type { Backtest, BacktestDetail, BacktestParams, BacktestSummary, ModelRun, SweepRow, SymbolInfo, ThresholdRow } from '../lib/types';
import { modelSymbols, pairLabel } from '../lib/symbols';
import { useAsync } from '../lib/useAsync';

const MAX_COMPARE = 3;

export function BacktesterPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const modelParam = searchParams.get('model');
  const backtestId = searchParams.get('bt');
  const { settledVersion, refresh: refreshJobs } = useJobs();

  const models = useAsync(() => api.models(), [settledVersion]);
  const doneModels = useMemo(() => (models.data ?? []).filter((run) => run.status === 'done'), [models.data]);
  const backtests = useAsync(() => api.backtests(), [settledVersion]);

  const [form, setForm] = useState<BacktestFormState>(emptyBacktestForm);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const formRef = useRef<HTMLDivElement | null>(null);

  const selectedModel = doneModels.find((run) => run.id === form.modelRunId) ?? null;
  const modelDetail = useAsync(() => (form.modelRunId ? api.model(form.modelRunId) : Promise.resolve(null)), [form.modelRunId]);
  const targetSymbol = selectedModel ? modelSymbols(selectedModel.params).target : null;
  const symbolInfo = useAsync(() => (targetSymbol ? api.validateSymbol(targetSymbol) : Promise.resolve(null)), [targetSymbol]);
  // Restored settings keep their own min notional instead of the coin's default.
  const keepMinNotionalFor = useRef<string | null>(null);

  const infoSymbol = symbolInfo.data?.symbol ?? null;
  const infoMinNotional = symbolInfo.data?.min_notional ?? null;
  useEffect(() => {
    if (!infoSymbol || infoMinNotional === null) return;
    if (keepMinNotionalFor.current === infoSymbol) {
      keepMinNotionalFor.current = null;
      return;
    }
    setForm((current) => ({ ...current, minNotional: String(infoMinNotional) }));
  }, [infoSymbol, infoMinNotional]);

  const symbolForModel = (modelRunId: string | null) => {
    const run = (models.data ?? []).find((candidate) => candidate.id === modelRunId);
    return run ? modelSymbols(run.params).target : null;
  };

  // Pick the model from ?model=, else keep the current one, else the newest finished model,
  // and fill the model-dependent defaults (OOF range, label exits).
  useEffect(() => {
    if (doneModels.length === 0) return;
    const target =
      doneModels.find((run) => run.id === modelParam) ??
      doneModels.find((run) => run.id === form.modelRunId) ??
      doneModels[0];
    if (target.id === form.modelRunId) return;
    setForm((current) => ({ ...current, ...formDefaultsForModel(target) }));
    // Runs on model list / URL changes only; switching in the form updates ?model= too.
  }, [doneModels, modelParam]);

  const selectModel = (id: string) => {
    const run = doneModels.find((candidate) => candidate.id === id);
    if (!run) return;
    keepMinNotionalFor.current = null;
    setForm((current) => ({ ...current, ...formDefaultsForModel(run) }));
    setSearchParams((params) => {
      params.set('model', id);
      return params;
    });
  };

  // Opening a saved backtest also selects its model, so the form matches the result shown.
  const openBacktest = (id: string | null) => {
    const record = id ? (backtests.data ?? []).find((candidate) => candidate.id === id) : null;
    const modelId = record?.model_run_id ?? record?.params.model_run_id;
    setSearchParams((params) => {
      if (id) params.set('bt', id);
      else params.delete('bt');
      if (modelId && doneModels.some((run) => run.id === modelId)) params.set('model', modelId);
      return params;
    });
  };

  // A shared ?bt= link without ?model= selects the backtest's model once both lists load.
  useEffect(() => {
    if (!backtestId || modelParam || !backtests.data || doneModels.length === 0) return;
    const record = backtests.data.find((candidate) => candidate.id === backtestId);
    const modelId = record?.model_run_id ?? record?.params.model_run_id;
    if (!modelId || !doneModels.some((run) => run.id === modelId)) return;
    setSearchParams((params) => {
      params.set('model', modelId);
      return params;
    });
  }, [backtestId, modelParam, backtests.data, doneModels, setSearchParams]);

  const loadSettings = (params: BacktestParams) => {
    const restored = formFromParams(params);
    const run = doneModels.find((candidate) => candidate.id === params.model_run_id);
    const defaults = run ? formDefaultsForModel(run) : null;
    const restoredSymbol = run ? modelSymbols(run.params).target : null;
    // Only the coin-default effect for a *different* coin would fire; skip it once for this one.
    keepMinNotionalFor.current = restoredSymbol && restoredSymbol !== targetSymbol ? restoredSymbol : null;
    setForm({
      ...restored,
      startDate: restored.startDate || defaults?.startDate || '',
      endDate: restored.endDate || defaults?.endDate || '',
    });
    setSearchParams((search) => {
      search.set('model', params.model_run_id);
      return search;
    });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const applySweepRow = (params: BacktestParams, row: SweepRow) => {
    loadSettings({ ...params, threshold: row.threshold, tp_pct: row.tp_pct, sl_pct: row.sl_pct, kind: 'single' });
  };

  const started = async (record: Backtest) => {
    await refreshJobs();
    backtests.reload();
    openBacktest(record.id);
  };

  const toggleCompare = (id: string) => {
    setCompareIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : current.length >= MAX_COMPARE ? current : [...current, id]));
  };

  const savedList = backtests.data ?? [];
  useEffect(() => {
    if (!backtests.data) return;
    setCompareIds((current) => current.filter((id) => backtests.data!.some((record) => record.id === id)));
  }, [backtests.data]);

  if (models.data && doneModels.length === 0) {
    return (
      <div className="space-y-4">
        <Card className="p-4 sm:p-5">
          <EmptyState
            icon={Brain}
            title="No trained models yet"
            action={
              <Link to="/models" className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-transparent bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90 sm:h-9">
                Go to Models
              </Link>
            }
          >
            Backtests replay a model's out-of-sample predictions, so train a model first.
            {models.data.some((run) => run.status !== 'done') ? ' A model is still training or failed.' : ''}
          </EmptyState>
        </Card>
        {savedList.length > 0 ? (
          <SavedBacktests list={savedList} selectedId={backtestId} compareIds={compareIds} onOpen={openBacktest} onToggleCompare={toggleCompare} onDeleted={backtests.reload} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
        <div ref={formRef} className="min-w-0 scroll-mt-20 space-y-4">
          {models.errorText && !models.data ? (
            <Notice tone="negative" icon={AlertTriangle}>
              Could not load models: {models.errorText}
            </Notice>
          ) : !models.data ? (
            <Card className="space-y-3 p-4 sm:p-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-48 w-full" />
            </Card>
          ) : (
            <BacktestForm
              form={form}
              setForm={setForm}
              models={doneModels}
              selectedModel={selectedModel}
              thresholds={modelDetail.data?.thresholds ?? null}
              symbolInfo={symbolInfo.data}
              onSelectModel={selectModel}
              onStarted={(record) => void started(record)}
            />
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {backtestId ? (
            <BacktestResult id={backtestId} symbolForModel={symbolForModel} onLoadSettings={loadSettings} onApplySweepRow={applySweepRow} />
          ) : (
            <Card className="p-4 sm:p-5">
              <EmptyState icon={FlaskConical} title="No backtest selected">
                Run a backtest or open a saved one below. Results include baselines (buy &amp; hold, random timing), equity, trades and monthly returns.
              </EmptyState>
            </Card>
          )}
        </div>
      </div>

      {compareIds.length >= 2 ? <ComparePanel ids={compareIds} onClear={() => setCompareIds([])} /> : null}

      <SavedBacktests
        list={savedList}
        loading={backtests.loading && !backtests.data}
        error={backtests.errorText}
        selectedId={backtestId}
        compareIds={compareIds}
        onOpen={openBacktest}
        onToggleCompare={toggleCompare}
        onDeleted={() => {
          backtests.reload();
        }}
      />
    </div>
  );
}

// ---- Form -------------------------------------------------------------------------------------

function issueFor(issues: FormIssue[], field: FormIssue['field']) {
  return issues.find((issue) => issue.field === field && issue.severity === 'error')?.message ?? null;
}

function hasWarning(issues: FormIssue[], field: FormIssue['field']) {
  return issues.some((issue) => issue.field === field && issue.severity === 'warning');
}

function BacktestForm({
  form,
  setForm,
  models,
  selectedModel,
  thresholds,
  symbolInfo,
  onSelectModel,
  onStarted,
}: {
  form: BacktestFormState;
  setForm: Dispatch<SetStateAction<BacktestFormState>>;
  models: ModelRun[];
  selectedModel: ModelRun | null;
  thresholds: ThresholdRow[] | null;
  symbolInfo: SymbolInfo | null;
  onSelectModel: (id: string) => void;
  onStarted: (record: Backtest) => void;
}) {
  const [submitting, setSubmitting] = useState<'single' | 'sweep' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepThresholds, setSweepThresholds] = useState('0.5, 0.55, 0.6, 0.65, 0.7, 0.75');
  const [sweepPairs, setSweepPairs] = useState('');
  const { issues, request } = validateBacktestForm(form);
  const set = <K extends keyof BacktestFormState>(key: K) => (value: BacktestFormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const defaults = selectedModel ? formDefaultsForModel(selectedModel) : null;
  const symbols = selectedModel ? modelSymbols(selectedModel.params) : null;
  const quote = symbolInfo?.quote_asset ?? 'USDT';
  const threshold = parseNumber(form.threshold);
  const thresholdRow = thresholdRowFor(thresholds, threshold);
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const generalErrors = issues.filter((issue) => issue.severity === 'error' && issue.field === 'modelRunId');

  // Seed the sweep's TP/SL list from the model label when it is empty.
  useEffect(() => {
    if (!sweepPairs && selectedModel) {
      const label = selectedModel.params.label;
      const round = (value: number) => Number(value.toFixed(3));
      setSweepPairs(`${label.tp_pct}/${label.sl_pct}, ${round(label.tp_pct * 1.5)}/${label.sl_pct}, ${label.tp_pct}/${round(label.sl_pct * 1.5)}`);
    }
  }, [selectedModel, sweepPairs]);

  // Dates equal to the model's OOF range are sent as "unset" so the backend uses the exact range.
  const finalRequest = () => {
    if (!request) return null;
    const body = { ...request };
    if (defaults && form.startDate === defaults.startDate) delete body.start_ts;
    if (defaults && form.endDate === defaults.endDate) delete body.end_ts;
    return body;
  };

  const sweep = request ? buildSweepRequest(request, sweepThresholds, sweepPairs) : null;

  const run = async (kind: 'single' | 'sweep', event?: FormEvent) => {
    event?.preventDefault();
    const body = finalRequest();
    if (!body) return;
    setSubmitting(kind);
    setSubmitError(null);
    try {
      if (kind === 'single') {
        onStarted(await api.runBacktest(body));
      } else {
        const sweepBody = buildSweepRequest(body, sweepThresholds, sweepPairs);
        if (!sweepBody.request) {
          setSubmitError(sweepBody.error);
          return;
        }
        onStarted(await api.runSweep(sweepBody.request));
      }
    } catch (cause) {
      setSubmitError(errorMessage(cause));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={FlaskConical}
        title="Backtest"
        description={`Replays the model's out-of-sample predictions on 1-second ${symbols?.target ?? 'target coin'} prices.`}
      />
      <form className="mt-5 space-y-5" onSubmit={(event) => void run('single', event)}>
        <label className="block min-w-0">
          <span className="mb-1.5 block text-sm font-medium text-fg-muted">Model run</span>
          <select value={form.modelRunId} onChange={(event) => onSelectModel(event.target.value)} className={inputClassName}>
            {form.modelRunId === '' ? <option value="">Choose a model</option> : null}
            {models.map((run) => (
              <option key={run.id} value={run.id}>
                {modelSymbols(run.params).target} · {run.name} · AUC {formatNumber(run.metrics?.overall.auc, 3)}
              </option>
            ))}
          </select>
          {selectedModel?.metrics ? (
            <span className="mt-1 block text-xs text-fg-subtle">
              {symbols ? `${pairLabel(symbols.target, symbols.context)} · ` : ''}OOF {formatDate(selectedModel.metrics.oof_start)} → {formatDate(selectedModel.metrics.oof_end)} · label TP {selectedModel.params.label.tp_pct}% / SL{' '}
              {selectedModel.params.label.sl_pct}% in {selectedModel.params.label.horizon_minutes}m ·{' '}
              <Link to={`/models/${selectedModel.id}`} className="underline hover:text-fg">
                details
              </Link>
            </span>
          ) : null}
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField type="date" label="Start (UTC)" value={form.startDate} onChange={set('startDate')} error={issueFor(issues, 'startDate')} />
          <TextField type="date" label="End (UTC, inclusive)" value={form.endDate} onChange={set('endDate')} error={issueFor(issues, 'endDate')} />
        </div>
        {defaults && (form.startDate !== defaults.startDate || form.endDate !== defaults.endDate) ? (
          <button type="button" className="-mt-3 text-xs text-accent-fg hover:underline" onClick={() => setForm((current) => ({ ...current, startDate: defaults.startDate, endDate: defaults.endDate }))}>
            Reset to the full out-of-sample range
          </button>
        ) : null}

        <div>
          <div className="flex items-end gap-3">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-sm font-medium text-fg-muted">Probability threshold</span>
              <input
                type="range"
                min={0.3}
                max={0.9}
                step={0.01}
                value={threshold !== null ? Math.min(0.9, Math.max(0.3, threshold)) : 0.6}
                onChange={(event) => set('threshold')(event.target.value)}
                className="h-10 w-full accent-[var(--color-accent)]"
                aria-label="Probability threshold slider"
              />
            </label>
            <NumberField label={<span className="sr-only">Threshold</span>} value={form.threshold} onChange={set('threshold')} error={null} step={0.01} min={0} max={1} className="w-24" />
          </div>
          {issueFor(issues, 'threshold') ? <p className="mt-1 text-xs text-negative">{issueFor(issues, 'threshold')}</p> : null}
          <ThresholdHint row={thresholdRow} threshold={threshold} hasTable={Boolean(thresholds && thresholds.length)} />
        </div>

        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold text-fg">Exits</legend>
          <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <NumberField label="Take profit" suffix="%" value={form.tpPct} onChange={set('tpPct')} error={issueFor(issues, 'tpPct')} warning={hasWarning(issues, 'tpPct')} step={0.05} />
            <NumberField label="Stop loss" suffix="%" value={form.slPct} onChange={set('slPct')} error={issueFor(issues, 'slPct')} step={0.05} />
            <NumberField label="Max hold" suffix="min" value={form.maxHoldMinutes} onChange={set('maxHoldMinutes')} error={issueFor(issues, 'maxHoldMinutes')} step={1} />
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold text-fg">Costs &amp; execution</legend>
          <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <NumberField label="Fee / side" suffix="%" value={form.feePct} onChange={set('feePct')} error={issueFor(issues, 'feePct')} step={0.005} hint="0.075 with BNB" />
            <NumberField label="Slippage" suffix="bps" value={form.slippageBps} onChange={set('slippageBps')} error={issueFor(issues, 'slippageBps')} step={0.5} hint="Entry & stops" />
            <NumberField label="Latency" suffix="s" value={form.latencySeconds} onChange={set('latencySeconds')} error={issueFor(issues, 'latencySeconds')} step={1} />
            <NumberField label="Cooldown" suffix="min" value={form.cooldownMinutes} onChange={set('cooldownMinutes')} error={issueFor(issues, 'cooldownMinutes')} step={1} hint="After each exit" />
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold text-fg">Capital &amp; sizing</legend>
          <div role="radiogroup" aria-label="Sizing" className="mt-2 grid grid-cols-2 gap-2">
            <ChoiceCard selected={form.sizing === 'compound'} title="Compound" detail="Fraction of equity" onSelect={() => set('sizing')('compound')} />
            <ChoiceCard selected={form.sizing === 'fixed'} title="Fixed" detail="Same quote per order" onSelect={() => set('sizing')('fixed')} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <NumberField label="Initial capital" suffix={quote} value={form.initialCapital} onChange={set('initialCapital')} error={issueFor(issues, 'initialCapital')} step={1} />
            {form.sizing === 'compound' ? (
              <NumberField
                label="Equity fraction"
                value={form.compoundFraction}
                onChange={set('compoundFraction')}
                error={issueFor(issues, 'compoundFraction')}
                warning={hasWarning(issues, 'compoundFraction')}
                step={0.05}
                hint="0–1 of equity per trade"
              />
            ) : (
              <NumberField
                label="Order size"
                suffix={quote}
                value={form.orderQuote}
                onChange={set('orderQuote')}
                error={issueFor(issues, 'orderQuote')}
                warning={hasWarning(issues, 'orderQuote')}
                step={1}
                hint="Capped by equity"
              />
            )}
            <NumberField
              label="Min notional"
              suffix={quote}
              value={form.minNotional}
              onChange={set('minNotional')}
              error={issueFor(issues, 'minNotional')}
              step={0.5}
              hint={
                symbolInfo && symbolInfo.min_notional !== null
                  ? `Binance ${symbolInfo.symbol}: ${formatNumber(symbolInfo.min_notional, 2)}${symbolInfo.qty_step ? ` · step ${symbolInfo.qty_step}` : ''}`
                  : "Default: the coin's Binance filter"
              }
            />
          </div>
        </fieldset>

        <TextField label="Name (optional)" value={form.name} onChange={set('name')} placeholder="auto: Backtest + timestamp" />

        {generalErrors.map((issue) => (
          <Notice key={issue.message} tone="negative" icon={AlertTriangle}>
            {issue.message}
          </Notice>
        ))}
        {warnings.map((issue) => (
          <Notice key={issue.message} tone="warning" icon={AlertTriangle}>
            {issue.message}
          </Notice>
        ))}
        {submitError ? (
          <Notice tone="negative" icon={AlertTriangle}>
            {submitError}
          </Notice>
        ) : null}

        <Button type="submit" variant="primary" icon={Play} className="w-full" disabled={!request || submitting !== null}>
          {submitting === 'single' ? 'Starting…' : 'Run backtest'}
        </Button>
      </form>

      <div className="mt-5">
        <Collapsible
          icon={Grid3x3}
          title="Sweep"
          description="Run many threshold × TP/SL combinations with the settings above."
          isOpen={sweepOpen}
          onToggle={() => setSweepOpen((value) => !value)}
        >
          <div className="space-y-4">
            <TextField label="Thresholds" value={sweepThresholds} onChange={setSweepThresholds} hint="Comma-separated, 0–1" error={sweep && !sweep.request && /threshold/i.test(sweep.error ?? '') ? sweep.error : null} />
            <TextField
              label="TP / SL pairs (%)"
              value={sweepPairs}
              onChange={setSweepPairs}
              hint="e.g. 0.6/0.4, 0.9/0.4, 0.6/0.6"
              error={sweep && !sweep.request && !/threshold/i.test(sweep.error ?? '') ? sweep.error : null}
            />
            <Notice tone="warning" icon={AlertTriangle}>
              The best combination on the same period is optimistic (overfit). Use the sweep to find robust regions, then confirm on another period.
            </Notice>
            {sweep?.request ? (
              <p className="text-xs text-fg-subtle">
                {sweep.request.thresholds.length} × {sweep.request.tp_sl_pairs.length} = {sweep.request.thresholds.length * sweep.request.tp_sl_pairs.length} combinations
              </p>
            ) : null}
            <Button variant="secondary" icon={Grid3x3} className="w-full" disabled={!sweep?.request || submitting !== null} onClick={() => void run('sweep')}>
              {submitting === 'sweep' ? 'Starting…' : 'Run sweep'}
            </Button>
          </div>
        </Collapsible>
      </div>
    </Card>
  );
}

function ThresholdHint({ row, threshold, hasTable }: { row: ThresholdRow | null; threshold: number | null; hasTable: boolean }) {
  if (!hasTable) return null;
  if (!row) {
    return <p className="mt-1.5 text-xs text-fg-subtle">Below the model's threshold table (starts at 0.30).</p>;
  }
  const exact = threshold !== null && Math.abs(row.threshold - threshold) < 1e-9;
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-fg-muted">
      <Info aria-hidden="true" strokeWidth={2} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="tabular-nums">
        {exact ? '' : `Nearest table row `}p ≥ {formatProbability(row.threshold, 2)}: fires on {formatRatio(row.share, 2)} of minutes ({formatInteger(row.n)}), hit rate{' '}
        {formatRatio(row.hit_rate)}, mean net{' '}
        <span className={cx('font-medium', toneText(signTone(row.mean_net_return_pct)))}>{formatPercent(row.mean_net_return_pct, 3, { sign: true })}</span> per
        signal (label exits, before overlap).
      </span>
    </div>
  );
}

// ---- Saved backtests --------------------------------------------------------------------------

function SavedBacktests({
  list,
  loading = false,
  error = null,
  selectedId,
  compareIds,
  onOpen,
  onToggleCompare,
  onDeleted,
}: {
  list: Backtest[];
  loading?: boolean;
  error?: string | null;
  selectedId: string | null;
  compareIds: string[];
  onOpen: (id: string | null) => void;
  onToggleCompare: (id: string) => void;
  onDeleted: () => void;
}) {
  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={History}
        title="Saved backtests"
        description={`Open one to see its results. Tick up to ${MAX_COMPARE} finished single runs to compare.`}
      />
      <div className="mt-4">
        {error && list.length === 0 ? (
          <Notice tone="negative" icon={AlertTriangle}>
            {error}
          </Notice>
        ) : loading ? (
          <Skeleton className="h-24 w-full" />
        ) : list.length === 0 ? (
          <EmptyState icon={History} title="No backtests yet" />
        ) : (
          <div className="relative overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className={cx(TABLE_HEAD_CELL, 'w-10')}>
                    <span className="sr-only">Compare</span>
                  </th>
                  <th className={TABLE_HEAD_CELL}>Name</th>
                  <th className={TABLE_HEAD_CELL}>Status</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Return</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Trades</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Max DD</th>
                  <th className={cx(TABLE_HEAD_CELL, 'text-right')}>vs random</th>
                  <th className={TABLE_HEAD_CELL}>Created</th>
                  <th className={TABLE_HEAD_CELL}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((record) => (
                  <SavedRow
                    key={record.id}
                    record={record}
                    selected={record.id === selectedId}
                    compared={compareIds.includes(record.id)}
                    compareFull={compareIds.length >= MAX_COMPARE}
                    onOpen={() => onOpen(record.id)}
                    onToggleCompare={() => onToggleCompare(record.id)}
                    onDeleted={() => {
                      if (record.id === selectedId) onOpen(null);
                      onDeleted();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function SavedRow({
  record,
  selected,
  compared,
  compareFull,
  onOpen,
  onToggleCompare,
  onDeleted,
}: {
  record: Backtest;
  selected: boolean;
  compared: boolean;
  compareFull: boolean;
  onOpen: () => void;
  onToggleCompare: () => void;
  onDeleted: () => void;
}) {
  const job = useLiveJob(record.job);
  const status = effectiveStatus(record.status, job);
  const summary = record.summary;
  const single = summary && !isSweepSummary(summary) ? summary : null;
  const best = summary && isSweepSummary(summary) ? summary.best : null;
  const [deleting, setDeleting] = useState(false);
  const comparable = record.params.kind !== 'sweep' && record.status === 'done';

  const remove = async () => {
    if (!window.confirm(`Delete backtest “${record.name}”?`)) return;
    setDeleting(true);
    try {
      await api.deleteBacktest(record.id);
      onDeleted();
    } catch (cause) {
      window.alert(errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  };

  const returnPct = single?.return_pct ?? best?.return_pct ?? null;

  return (
    <tr className={cx('hover:bg-surface-2', selected && 'bg-accent/[0.06]')}>
      <td className={TABLE_CELL}>
        <input
          type="checkbox"
          aria-label={`Compare ${record.name}`}
          checked={compared}
          disabled={!comparable || (!compared && compareFull)}
          onChange={onToggleCompare}
          className="h-4 w-4 accent-[var(--color-accent)] disabled:opacity-40"
        />
      </td>
      <td className={cx(TABLE_CELL, 'max-w-[18rem]')}>
        <button type="button" onClick={onOpen} className="block max-w-full truncate text-left font-medium text-accent-fg hover:underline" title={record.name}>
          {record.name}
        </button>
        <span className="text-xs text-fg-subtle">
          {record.params.kind === 'sweep'
            ? `sweep · ${summary && isSweepSummary(summary) ? `${summary.combinations} combos, best p≥${best?.threshold} ${best?.tp_pct}/${best?.sl_pct}` : `${record.params.thresholds?.length ?? 0} thresholds`}`
            : `p ≥ ${record.params.threshold} · TP ${record.params.tp_pct}% / SL ${record.params.sl_pct}%`}
        </span>
      </td>
      <td className={TABLE_CELL}>
        <StatusBadge status={status} progress={job?.progress} />
      </td>
      <td className={cx(TABLE_CELL, 'text-right font-medium', toneText(signTone(returnPct)))}>
        {formatPercent(returnPct, 2, { sign: true })}
        {best ? <span className="block text-xs font-normal text-fg-subtle">best</span> : null}
      </td>
      <td className={cx(TABLE_CELL, 'text-right')}>{formatInteger(single?.trades ?? best?.trades)}</td>
      <td className={cx(TABLE_CELL, 'text-right')}>{formatPercent(single?.max_drawdown_pct ?? best?.max_drawdown_pct, 1)}</td>
      <td className={cx(TABLE_CELL, 'text-right')}>
        {single?.random_percentile != null ? (
          <span className={single.random_percentile >= 95 ? 'text-positive' : single.random_percentile >= 50 ? 'text-warning' : 'text-negative'}>
            {formatNumber(single.random_percentile, 0)}%
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className={cx(TABLE_CELL, 'whitespace-nowrap text-fg-muted')}>{formatAge(record.created_at)}</td>
      <td className={cx(TABLE_CELL, 'text-right')}>
        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${record.name}`} title="Delete" disabled={deleting} onClick={() => void remove()} />
      </td>
    </tr>
  );
}

// ---- Compare ----------------------------------------------------------------------------------

function ComparePanel({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const key = ids.join(',');
  const details = useAsync(() => Promise.all(ids.map((id) => api.backtest(id))), [key]);
  const palette = useChartPalette();
  const records = useMemo(
    () =>
      (details.data ?? []).filter((record): record is BacktestDetail & { summary: BacktestSummary } =>
        Boolean(record.summary && !isSweepSummary(record.summary)),
      ),
    [details.data],
  );

  const lines = useMemo<LineSpec[]>(
    () =>
      records.map((record) => ({
        id: record.id,
        label: record.name,
        colorIndex: ids.indexOf(record.id),
        data: toLineData(record.equity, (point) => point.t, (point) => (point.equity / record.params.initial_capital) * 100),
      })),
    [records, ids],
  );

  const metricRows: Array<{ label: string; value: (summary: BacktestSummary) => string; tone?: (summary: BacktestSummary) => number | null }> = [
    { label: 'Return', value: (s) => formatPercent(s.return_pct, 2, { sign: true }), tone: (s) => s.return_pct },
    { label: 'Trades', value: (s) => formatInteger(s.trades) },
    { label: 'Win rate', value: (s) => formatRatio(s.win_rate) },
    { label: 'Profit factor', value: (s) => formatNumber(s.profit_factor, 2) },
    { label: 'Max drawdown', value: (s) => formatPercent(s.max_drawdown_pct, 2) },
    { label: 'Sharpe', value: (s) => formatNumber(s.sharpe, 2), tone: (s) => s.sharpe },
    { label: 'Fees paid', value: (s) => formatNumber(s.fees_paid, 2) },
    { label: 'vs buy & hold', value: (s) => formatPercent(s.vs_buy_and_hold_pct, 2, { sign: true }), tone: (s) => s.vs_buy_and_hold_pct },
    { label: 'Beats random', value: (s) => (s.random_percentile == null ? '—' : `${formatNumber(s.random_percentile, 0)}%`) },
    { label: 'Period', value: (s) => `${formatDate(s.start_ts)} → ${formatDate(s.end_ts)}` },
  ];

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={Columns3}
        title="Compare backtests"
        description="Equity indexed to 100 at the start so different capital sizes line up."
        aside={
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        }
      />
      {details.errorText ? (
        <Notice tone="negative" icon={AlertTriangle} className="mt-3">
          {details.errorText}
        </Notice>
      ) : !details.data ? (
        <Skeleton className="mt-4 h-48 w-full" />
      ) : (
        <>
          <div className="relative mt-4 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className={TABLE_HEAD_CELL}>Metric</th>
                  {records.map((record) => (
                    <th key={record.id} className={cx(TABLE_HEAD_CELL, 'max-w-[14rem] text-right')}>
                      <span className="inline-flex max-w-full items-center gap-1.5">
                        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette.series[ids.indexOf(record.id) % palette.series.length] }} />
                        <span className="truncate" title={record.name}>
                          {record.name}
                        </span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metricRows.map((row) => (
                  <tr key={row.label}>
                    <td className={cx(TABLE_CELL, 'text-fg-muted')}>{row.label}</td>
                    {records.map((record) => (
                      <td key={record.id} className={cx(TABLE_CELL, 'whitespace-nowrap text-right', row.tone && toneText(signTone(row.tone(record.summary))))}>
                        {row.value(record.summary)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            {records.map((record) => (
              <LegendLine key={record.id} color={palette.series[ids.indexOf(record.id) % palette.series.length]} label={record.name} />
            ))}
          </div>
          <div className="mt-3">
            <LineOverlayChart lines={lines} height={280} precision={2} />
          </div>
        </>
      )}
    </Card>
  );
}
