import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, BarChart3, FlaskConical, Gauge, ListOrdered, Table2, Trash2 } from 'lucide-react';

import { JobProgress } from '../components/JobProgress';
import { CalibrationChart, FoldAucChart, ImportanceBars, ProbabilityHistogram } from '../components/SvgCharts';
import { Badge, Button, Card, EmptyState, Inset, KeyValue, Notice, SectionTitle, Skeleton, Stat, StatusBadge, TABLE_CELL, TABLE_HEAD_CELL, cx, toneText } from '../components/ui';
import { api, errorMessage, isNotFound } from '../lib/api';
import { formatDate, formatDuration, formatInteger, formatNumber, formatPercent, formatProbability, formatRatio, signTone } from '../lib/format';
import { effectiveStatus, isActiveStatus, useJobs, useLiveJob } from '../lib/jobs';
import { modelSymbols } from '../lib/symbols';
import type { FoldReport, ModelRunDetail, ThresholdRow } from '../lib/types';
import { useAsync } from '../lib/useAsync';

export function ModelDetailPage() {
  const { id = '' } = useParams();
  const { settledVersion } = useJobs();
  const run = useAsync(() => api.model(id), [id, settledVersion]);

  if (run.error && isNotFound(run.error)) {
    return (
      <Card className="p-4 sm:p-5">
        <EmptyState icon={AlertTriangle} title="Model run not found" action={<BackLink />}>
          It may have been deleted.
        </EmptyState>
      </Card>
    );
  }
  if (run.errorText && !run.data) {
    return (
      <Notice tone="negative" icon={AlertTriangle}>
        Could not load the model run: {run.errorText}
      </Notice>
    );
  }
  if (!run.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return <ModelDetail run={run.data} />;
}

function BackLink() {
  return (
    <Link to="/models" className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
      <ArrowLeft aria-hidden="true" strokeWidth={2} className="h-4 w-4" />
      All models
    </Link>
  );
}

function ModelDetail({ run }: { run: ModelRunDetail }) {
  const navigate = useNavigate();
  const job = useLiveJob(run.job);
  const status = effectiveStatus(run.status, job);
  const [deleting, setDeleting] = useState(false);
  const metrics = run.metrics;
  const overall = metrics?.overall;
  const params = run.params;
  const symbols = modelSymbols(params);

  const remove = async () => {
    if (!window.confirm(`Delete model run “${run.name}” and its predictions?`)) return;
    setDeleting(true);
    try {
      await api.deleteModel(run.id);
      navigate('/models');
    } catch (cause) {
      window.alert(errorMessage(cause));
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <BackLink />
      <Card as="section" className="min-w-0 p-4 sm:p-5">
        <SectionTitle
          title={
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate">{run.name}</span>
              <StatusBadge status={status} progress={job?.progress} />
              <Badge tone="accent">{symbols.target}</Badge>
              <Badge>{params.model_type}</Badge>
            </span>
          }
          description={`TP ${params.label.tp_pct}% before SL ${params.label.sl_pct}% within ${params.label.horizon_minutes} min · latency ${params.label.latency_seconds}s · ${params.walk_forward.window} ${params.walk_forward.train_months}m train / ${params.walk_forward.test_months}m test · context ${symbols.context ?? 'none'}`}
          aside={
            <>
              <Button
                variant="primary"
                icon={FlaskConical}
                disabled={run.status !== 'done'}
                title={run.status !== 'done' ? 'Available once training is done' : undefined}
                onClick={() => navigate(`/backtest?model=${encodeURIComponent(run.id)}`)}
              >
                Backtest this model
              </Button>
              <Button variant="danger" icon={Trash2} disabled={deleting} onClick={() => void remove()}>
                Delete
              </Button>
            </>
          }
        />
        {job && (isActiveStatus(job.status) || job.status === 'failed' || job.status === 'cancelled') ? (
          <JobProgress job={job} className="mt-4" />
        ) : null}

        {metrics && overall ? (
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <MetricTile label="AUC" value={formatNumber(overall.auc, 4)} tone={overall.auc == null ? 'neutral' : overall.auc > 0.5 ? 'positive' : 'negative'} detail="0.5 = random" />
            <MetricTile
              label="Logloss skill"
              value={formatPercent(overall.logloss_skill == null ? null : overall.logloss_skill * 100, 2, { sign: true })}
              tone={signTone(overall.logloss_skill)}
              detail="vs base rate"
            />
            <MetricTile label="Base rate" value={formatRatio(overall.base_rate)} detail="TP-first share" />
            <MetricTile label="Brier" value={formatNumber(overall.brier, 4)} />
            <MetricTile label="Top-10% hit rate" value={formatRatio(overall.top_decile_hit_rate)} />
            <MetricTile
              label="Top-10% net / trade"
              value={formatPercent(overall.top_decile_net_return_pct, 3, { sign: true })}
              tone={signTone(overall.top_decile_net_return_pct)}
              detail={`after ${formatNumber(params.fee_pct * 2, 3)}% fees`}
            />
            <MetricTile
              label="All minutes net"
              value={formatPercent(overall.mean_net_return_all_pct, 3, { sign: true })}
              tone={signTone(overall.mean_net_return_all_pct)}
              detail="enter every minute"
            />
            <MetricTile label="OOF minutes" value={formatInteger(overall.n)} detail={`${metrics.folds} folds · ${metrics.features} features`} />
          </div>
        ) : run.status === 'done' ? null : (
          <p className="mt-4 text-sm text-fg-muted">Metrics appear when training finishes.</p>
        )}
        {metrics ? (
          <div className="mt-4 grid gap-x-8 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <KeyValue label="Out-of-sample period" value={`${formatDate(metrics.oof_start)} → ${formatDate(metrics.oof_end)}`} />
            <KeyValue label="Training time" value={formatDuration(metrics.train_seconds)} />
            <KeyValue label="Train stride" value={`${params.train_stride_minutes} min`} />
          </div>
        ) : null}
      </Card>

      {run.folds && run.folds.length > 0 ? <FoldsSection folds={run.folds} /> : null}

      {(run.calibration && run.calibration.length > 0) || (run.histogram && run.histogram.length > 0) ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {run.calibration && run.calibration.length > 0 ? (
            <Card as="section" className="min-w-0 p-4 sm:p-5">
              <SectionTitle icon={Gauge} title="Calibration" description="Mean predicted probability vs observed TP-first rate, per decile. Dashed = perfect calibration." />
              <div className="mt-4">
                <CalibrationChart bins={run.calibration} />
              </div>
            </Card>
          ) : null}
          {run.histogram && run.histogram.length > 0 ? (
            <Card as="section" className="min-w-0 p-4 sm:p-5">
              <SectionTitle icon={BarChart3} title="Probability distribution" description="Out-of-sample predictions per minute. Highlighted: at or above 0.6." />
              <div className="mt-4">
                <ProbabilityHistogram bins={run.histogram} threshold={0.6} />
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {run.thresholds && run.thresholds.length > 0 ? <ThresholdTable rows={run.thresholds} feePct={params.fee_pct} /> : null}

      {run.importance && run.importance.length > 0 ? (
        <Card as="section" className="min-w-0 p-4 sm:p-5">
          <SectionTitle
            icon={ListOrdered}
            title="Feature importance"
            description={`Top 30 of ${run.importance.length}, averaged over folds (${params.model_type === 'lgbm' ? 'gain share' : '|coefficient| share'}).`}
          />
          <div className="mt-4">
            <ImportanceBars rows={run.importance} limit={30} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function MetricTile({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail?: string; tone?: 'neutral' | 'positive' | 'negative' }) {
  return (
    <Inset className="min-w-0 px-3 py-2.5">
      <Stat size="sm" label={label} value={value} detail={detail} tone={tone} />
    </Inset>
  );
}

function FoldsSection({ folds }: { folds: FoldReport[] }) {
  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle icon={Table2} title="Walk-forward folds" description="Each fold is tested on months its model never saw." />
      <div className="mt-4">
        <p className="mb-1 text-xs font-medium text-fg-muted">AUC per fold</p>
        <FoldAucChart folds={folds} />
      </div>
      <div className="relative mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className={TABLE_HEAD_CELL}>#</th>
              <th className={TABLE_HEAD_CELL}>Test period</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Train rows</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Test rows</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>AUC</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Skill</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Top-10% hit</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Top-10% net</th>
            </tr>
          </thead>
          <tbody>
            {folds.map((fold) => (
              <tr key={fold.index} className="hover:bg-surface-2">
                <td className={cx(TABLE_CELL, 'text-fg-muted')}>{fold.index + 1}</td>
                <td className={cx(TABLE_CELL, 'whitespace-nowrap')}>
                  {formatDate(fold.test_start)} → {formatDate(fold.test_end - 1)}
                </td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatInteger(fold.train_rows)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatInteger(fold.n)}</td>
                <td className={cx(TABLE_CELL, 'text-right', fold.auc == null ? 'text-fg-subtle' : fold.auc > 0.5 ? 'text-positive' : 'text-negative')}>
                  {formatNumber(fold.auc, 4)}
                </td>
                <td className={cx(TABLE_CELL, 'text-right', toneText(signTone(fold.logloss_skill)))}>
                  {formatPercent(fold.logloss_skill == null ? null : fold.logloss_skill * 100, 2, { sign: true })}
                </td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatRatio(fold.top_decile_hit_rate)}</td>
                <td className={cx(TABLE_CELL, 'text-right', toneText(signTone(fold.top_decile_net_return_pct)))}>
                  {formatPercent(fold.top_decile_net_return_pct, 3, { sign: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ThresholdTable({ rows, feePct }: { rows: ThresholdRow[]; feePct: number }) {
  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={Table2}
        title="Thresholds"
        description={`Entering every minute with probability ≥ threshold, exits per the label. Net return is per trade after ${formatNumber(feePct * 2, 3)}% round-trip fees, ignoring overlap and sizing.`}
      />
      <div className="relative mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className={TABLE_HEAD_CELL}>Threshold</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Share of minutes</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Minutes</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Hit rate</th>
              <th className={cx(TABLE_HEAD_CELL, 'text-right')}>Mean net return</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.threshold} className={cx('hover:bg-surface-2', row.n === 0 && 'text-fg-subtle')}>
                <td className={TABLE_CELL}>≥ {formatProbability(row.threshold, 2)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatRatio(row.share, 2)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatInteger(row.n)}</td>
                <td className={cx(TABLE_CELL, 'text-right')}>{formatRatio(row.hit_rate)}</td>
                <td className={cx(TABLE_CELL, 'text-right font-medium', toneText(signTone(row.mean_net_return_pct)))}>
                  {formatPercent(row.mean_net_return_pct, 3, { sign: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
