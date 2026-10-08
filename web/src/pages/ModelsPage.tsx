import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Brain, Info, Layers, Play, Plus, Settings2, Trash2 } from 'lucide-react';

import { NumberField, TextField } from '../components/FormFields';
import { Button, Card, ChoiceCard, Collapsible, EmptyState, Notice, ProgressBar, SectionTitle, Skeleton, StatusBadge, TABLE_CELL, TABLE_HEAD_CELL, cx, inputClassName, toneText } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatAge, formatDate, formatNumber, formatPercent, formatRatio, signTone } from '../lib/format';
import { effectiveStatus, isActiveStatus, useJobs, useLiveJob } from '../lib/jobs';
import { defaultTrainForm, validateTrainForm, type TrainFormState } from '../lib/trainForm';
import { modelSymbols, pairLabel } from '../lib/symbols';
import type { DataStatus, ModelRun } from '../lib/types';
import { useAsync } from '../lib/useAsync';

export function ModelsPage() {
  const { settledVersion } = useJobs();
  const [targetFilter, setTargetFilter] = useState('');
  const runs = useAsync(() => api.models(targetFilter || undefined), [settledVersion, targetFilter]);
  const status = useAsync(() => api.dataStatus(), [settledVersion]);
  const [showForm, setShowForm] = useState(false);
  const coins = (status.data?.symbols ?? []).map((item) => item.symbol);

  return (
    <div className="space-y-4">
      <Card as="section" className="min-w-0 p-4 sm:p-5">
        <SectionTitle
          icon={Brain}
          title="Model runs"
          description="Each run trains one model per walk-forward fold and keeps only out-of-sample predictions."
          aside={
            <>
              <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
                <span className="sr-only sm:not-sr-only">Coin</span>
                <select
                  value={targetFilter}
                  onChange={(event) => setTargetFilter(event.target.value)}
                  aria-label="Filter by traded coin"
                  className="h-11 rounded-lg border border-line-strong bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent/70 sm:h-9"
                >
                  <option value="">All coins</option>
                  {[...new Set([...coins, targetFilter].filter(Boolean))].map((coin) => (
                    <option key={coin} value={coin}>
                      {coin}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant={showForm ? 'secondary' : 'primary'} icon={Plus} onClick={() => setShowForm((value) => !value)}>
                {showForm ? 'Hide form' : 'Train new model'}
              </Button>
            </>
          }
        />
        <div className="mt-4">
          <RunsTable
            runs={runs.data}
            loading={runs.loading && !runs.data}
            error={runs.errorText}
            filtered={Boolean(targetFilter)}
            onChanged={runs.reload}
            onTrain={() => setShowForm(true)}
          />
        </div>
      </Card>

      {showForm ? (
        <TrainForm
          status={status.data}
          onCreated={() => {
            setShowForm(false);
            runs.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function RunsTable({
  runs,
  loading,
  error,
  filtered,
  onChanged,
  onTrain,
}: {
  runs: ModelRun[] | null;
  loading: boolean;
  error: string | null;
  filtered: boolean;
  onChanged: () => void;
  onTrain: () => void;
}) {
  if (error && !runs) {
    return (
      <Notice tone="negative" icon={AlertTriangle}>
        Could not load model runs: {error}
      </Notice>
    );
  }
  if (loading || !runs) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (runs.length === 0 && filtered) {
    return <EmptyState icon={Brain} title="No models for this coin" />;
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={Brain}
        title="No models trained yet"
        action={
          <Button variant="primary" icon={Plus} onClick={onTrain}>
            Train new model
          </Button>
        }
      >
        Train a walk-forward model once the feature set is built (Data page).
      </EmptyState>
    );
  }

  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[1040px] text-sm">
        <thead className="bg-surface-2">
          <tr>
            <th className={TABLE_HEAD_CELL}>Name</th>
            <th className={TABLE_HEAD_CELL}>Coin</th>
            <th className={TABLE_HEAD_CELL}>Type</th>
            <th className={TABLE_HEAD_CELL}>Status</th>
            <th className={cx(TABLE_HEAD_CELL, 'text-right')} title="Area under the ROC curve on out-of-sample predictions (0.5 = random)">
              AUC
            </th>
            <th className={cx(TABLE_HEAD_CELL, 'text-right')} title="1 − logloss / logloss of the base rate (>0 beats the base rate)">
              Logloss skill
            </th>
            <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Top-10% hit</th>
            <th className={cx(TABLE_HEAD_CELL, 'text-right')} title="Mean net return per trade of the top-decile predictions after round-trip fees">
              Top-10% net
            </th>
            <th className={TABLE_HEAD_CELL}>OOF period</th>
            <th className={TABLE_HEAD_CELL}>Created</th>
            <th className={TABLE_HEAD_CELL}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run, onChanged }: { run: ModelRun; onChanged: () => void }) {
  const job = useLiveJob(run.job);
  const status = effectiveStatus(run.status, job);
  const overall = run.metrics?.overall;
  const [deleting, setDeleting] = useState(false);
  const auc = overall?.auc ?? null;
  const symbols = modelSymbols(run.params);

  const remove = async () => {
    if (!window.confirm(`Delete model run “${run.name}” and its predictions?`)) return;
    setDeleting(true);
    try {
      await api.deleteModel(run.id);
      onChanged();
    } catch (cause) {
      window.alert(errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <tr className="hover:bg-surface-2">
      <td className={cx(TABLE_CELL, 'max-w-[16rem]')}>
        <Link to={`/models/${run.id}`} className="block truncate font-medium text-accent-fg hover:underline" title={run.name}>
          {run.name}
        </Link>
        <span className="text-xs text-fg-subtle">
          TP {run.params.label.tp_pct}% / SL {run.params.label.sl_pct}% · {run.params.label.horizon_minutes}m
        </span>
      </td>
      <td className={cx(TABLE_CELL, 'whitespace-nowrap')}>
        <span className="font-medium">{symbols.target}</span>
        <span className="block text-xs text-fg-subtle">{symbols.context ? `ctx ${symbols.context}` : 'no context'}</span>
      </td>
      <td className={cx(TABLE_CELL, 'text-fg-muted')}>{run.params.model_type}</td>
      <td className={cx(TABLE_CELL, 'min-w-[9rem]')}>
        <StatusBadge status={status} progress={job?.progress} />
        {job && isActiveStatus(job.status) ? (
          <>
            <ProgressBar value={job.progress} className="mt-1.5" />
            {job.message ? (
              <span className="mt-1 block max-w-[14rem] truncate text-xs text-fg-subtle" title={job.message}>
                {job.message}
              </span>
            ) : null}
          </>
        ) : null}
        {status === 'failed' && job?.error ? (
          <span className="mt-1 block max-w-[14rem] truncate text-xs text-negative" title={job.error}>
            {job.error}
          </span>
        ) : null}
      </td>
      <td className={cx(TABLE_CELL, 'text-right', auc === null ? 'text-fg-subtle' : auc > 0.5 ? 'text-positive' : 'text-negative')}>
        {formatNumber(auc, 4)}
      </td>
      <td className={cx(TABLE_CELL, 'text-right', toneText(signTone(overall?.logloss_skill)))}>
        {formatPercent(overall?.logloss_skill === null || overall?.logloss_skill === undefined ? null : overall.logloss_skill * 100, 2, { sign: true })}
      </td>
      <td className={cx(TABLE_CELL, 'text-right')}>{formatRatio(overall?.top_decile_hit_rate)}</td>
      <td className={cx(TABLE_CELL, 'text-right', toneText(signTone(overall?.top_decile_net_return_pct)))}>
        {formatPercent(overall?.top_decile_net_return_pct, 3, { sign: true })}
      </td>
      <td className={cx(TABLE_CELL, 'whitespace-nowrap text-fg-muted')}>
        {run.metrics ? `${formatDate(run.metrics.oof_start)} → ${formatDate(run.metrics.oof_end)}` : '—'}
      </td>
      <td className={cx(TABLE_CELL, 'whitespace-nowrap text-fg-muted')} title={new Date(run.created_at * 1000).toISOString()}>
        {formatAge(run.created_at)}
      </td>
      <td className={cx(TABLE_CELL, 'text-right')}>
        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${run.name}`} title="Delete" disabled={deleting} onClick={() => void remove()} />
      </td>
    </tr>
  );
}

function TrainForm({ status, onCreated }: { status: DataStatus | null; onCreated: () => void }) {
  const navigate = useNavigate();
  const { refresh } = useJobs();
  const [form, setForm] = useState<TrainFormState>(defaultTrainForm);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, warnings, request } = validateTrainForm(form);
  const set = <K extends keyof TrainFormState>(key: K) => (value: TrainFormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const coverage = status?.symbols ?? [];
  const coins = [...new Set([...coverage.map((item) => item.symbol), form.targetSymbol, form.contextSymbol].filter(Boolean))];
  const hasBars = (symbol: string) => coverage.some((item) => item.symbol === symbol && item.bars_built);
  const context = form.contextSymbol || null;
  const featureSet = status?.features?.find((set) => set.target === form.targetSymbol && (set.context ?? null) === context) ?? null;
  const missingBars = [form.targetSymbol, context].filter((symbol): symbol is string => Boolean(symbol) && !hasBars(symbol!));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const run = await api.trainModel(request);
      await refresh();
      onCreated();
      navigate(`/models/${run.id}`);
    } catch (cause) {
      setSubmitError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle icon={Plus} title="Train new model" />
      <Notice tone="accent" icon={Info} className="mt-3">
        <p>
          <span className="font-medium">Label:</span> for every 1-minute decision, did price hit the take-profit before the stop-loss within the
          horizon? It is checked on 1-second data, starting after the latency.
        </p>
        <p className="mt-1 text-fg-muted">
          Walk-forward: each fold trains only on data before its test window (with a purge gap). Backtests use only these out-of-sample
          predictions, never in-sample fits.
        </p>
      </Notice>

      <form className="mt-5 space-y-5" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" value={form.name} onChange={set('name')} placeholder="auto: model type + timestamp" />
          <div>
            <span className="mb-1.5 block text-sm font-medium text-fg-muted">Model type</span>
            <div role="radiogroup" aria-label="Model type" className="grid grid-cols-2 gap-2">
              <ChoiceCard selected={form.modelType === 'lgbm'} title="LightGBM" detail="Gradient-boosted trees" onSelect={() => set('modelType')('lgbm')} />
              <ChoiceCard selected={form.modelType === 'logreg'} title="Logistic" detail="Linear baseline" onSelect={() => set('modelType')('logreg')} />
            </div>
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold text-fg">Coins</legend>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <SymbolSelect
              label="Traded coin"
              value={form.targetSymbol}
              options={coins}
              hasBars={hasBars}
              onChange={set('targetSymbol')}
              error={errors.targetSymbol}
            />
            <SymbolSelect
              label="Context coin"
              value={form.contextSymbol}
              options={coins.filter((coin) => coin !== form.targetSymbol)}
              hasBars={hasBars}
              allowNone
              onChange={set('contextSymbol')}
              error={errors.contextSymbol}
              hint="Its features (ctx_*, x_*) help predict the traded coin"
            />
          </div>
          {status && missingBars.length > 0 ? (
            <Notice tone="warning" icon={Layers} className="mt-3">
              No 1m bars for {missingBars.join(' and ')} yet; training would fail. Download and build {missingBars.length > 1 ? 'them' : 'it'} on the{' '}
              <Link to="/data" className="font-medium underline">
                Data page
              </Link>
              .
            </Notice>
          ) : status && !featureSet ? (
            <Notice tone="neutral" icon={Layers} className="mt-3">
              No feature set for {pairLabel(form.targetSymbol, context)} yet; the training job builds it first.
            </Notice>
          ) : featureSet ? (
            <p className="mt-2 text-xs text-fg-subtle">
              Feature set {pairLabel(form.targetSymbol, context)}: {featureSet.feature_count} features, {formatDate(featureSet.first_ts)} →{' '}
              {formatDate(featureSet.last_ts)}.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold text-fg">Label</legend>
          <div className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-4">
            <NumberField label="Take profit" suffix="%" value={form.tpPct} onChange={set('tpPct')} error={errors.tpPct} step={0.05} />
            <NumberField label="Stop loss" suffix="%" value={form.slPct} onChange={set('slPct')} error={errors.slPct} step={0.05} />
            <NumberField label="Horizon" suffix="min" value={form.horizonMinutes} onChange={set('horizonMinutes')} error={errors.horizonMinutes} step={1} />
            <NumberField label="Latency" suffix="s" value={form.latencySeconds} onChange={set('latencySeconds')} error={errors.latencySeconds} step={1} hint="Delay before entry" />
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold text-fg">Walk-forward</legend>
          <div className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-4">
            <NumberField label="Train months" value={form.trainMonths} onChange={set('trainMonths')} error={errors.trainMonths} step={1} />
            <NumberField label="Test months" value={form.testMonths} onChange={set('testMonths')} error={errors.testMonths} step={1} />
            <NumberField label="Min train months" value={form.minTrainMonths} onChange={set('minTrainMonths')} error={errors.minTrainMonths} step={1} hint="History before the first test" />
            <NumberField label="Train stride" suffix="min" value={form.trainStrideMinutes} onChange={set('trainStrideMinutes')} error={errors.trainStrideMinutes} step={1} hint="Every Nth minute for training" />
          </div>
          <div role="radiogroup" aria-label="Training window" className="mt-3 grid gap-2 sm:grid-cols-2">
            <ChoiceCard selected={form.window === 'rolling'} title="Rolling window" detail="Train on the last N months" onSelect={() => set('window')('rolling')} />
            <ChoiceCard selected={form.window === 'expanding'} title="Expanding window" detail="Train on all history so far" onSelect={() => set('window')('expanding')} />
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Fee per side" suffix="%" value={form.feePct} onChange={set('feePct')} error={errors.feePct} step={0.005} hint="Used for net-return metrics (0.075 with BNB)" />
        </div>

        {form.modelType === 'lgbm' ? (
          <Collapsible icon={Settings2} title="Advanced LightGBM parameters" isOpen={advancedOpen} onToggle={() => setAdvancedOpen((value) => !value)}>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <NumberField label="num_leaves" value={form.numLeaves} onChange={set('numLeaves')} error={errors.numLeaves} step={1} />
              <NumberField label="learning_rate" value={form.learningRate} onChange={set('learningRate')} error={errors.learningRate} step={0.005} />
              <NumberField label="min_data_in_leaf" value={form.minDataInLeaf} onChange={set('minDataInLeaf')} error={errors.minDataInLeaf} step={10} />
              <NumberField label="feature_fraction" value={form.featureFraction} onChange={set('featureFraction')} error={errors.featureFraction} step={0.05} />
              <NumberField label="max_rounds" value={form.maxRounds} onChange={set('maxRounds')} error={errors.maxRounds} step={100} hint="Early stopping" />
            </div>
          </Collapsible>
        ) : null}

        {warnings.map((warning) => (
          <Notice key={warning} tone="warning" icon={AlertTriangle}>
            {warning}
          </Notice>
        ))}
        {submitError ? (
          <Notice tone="negative" icon={AlertTriangle}>
            {submitError}
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" icon={Play} disabled={!request || submitting}>
            {submitting ? 'Starting…' : 'Start training'}
          </Button>
          <Button variant="ghost" onClick={() => setForm(defaultTrainForm())}>
            Reset to defaults
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SymbolSelect({
  label,
  value,
  options,
  hasBars,
  allowNone,
  onChange,
  error,
  hint,
}: {
  label: string;
  value: string;
  options: string[];
  hasBars: (symbol: string) => boolean;
  allowNone?: boolean;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-sm font-medium text-fg-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cx(inputClassName, error && 'border-negative/70')}
      >
        {allowNone ? <option value="">None</option> : null}
        {options.map((symbol) => (
          <option key={symbol} value={symbol}>
            {symbol}
            {hasBars(symbol) ? '' : ' (no 1m bars)'}
          </option>
        ))}
      </select>
      {error ? <span className="mt-1 block text-xs text-negative">{error}</span> : hint ? <span className="mt-1 block text-xs text-fg-subtle">{hint}</span> : null}
    </label>
  );
}
