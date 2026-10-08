import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, ListChecks, RefreshCw, ScrollText, X } from 'lucide-react';

import { Button, Card, EmptyState, Notice, ProgressBar, SectionTitle, Skeleton, StatusBadge, cx } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { JOB_KIND_LABEL, isActiveStatus, useJobs } from '../lib/jobs';
import type { Job } from '../lib/types';

export function JobsPage() {
  const { jobs, loaded, error, active, refresh } = useJobs();

  return (
    <Card as="section" className="min-w-0 p-4 sm:p-5">
      <SectionTitle
        icon={ListChecks}
        title="Jobs"
        description={
          active.length > 0
            ? `${active.length} active · refreshing every 2s. Jobs run one at a time in a separate worker process.`
            : 'Downloads, builds, training and backtests. Jobs run one at a time in a separate worker process.'
        }
        aside={
          <Button size="sm" icon={RefreshCw} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      <div className="mt-4">
        {error ? (
          <Notice tone="negative" icon={AlertTriangle} className="mb-3">
            {error}
          </Notice>
        ) : null}
        {!loaded ? (
          <Skeleton className="h-32 w-full" />
        ) : jobs.length === 0 ? (
          <EmptyState icon={ListChecks} title="No jobs yet">
            Start with a download on the <Link to="/data" className="underline">Data page</Link>.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function relatedLink(job: Job): { to: string; label: string } | null {
  const params = job.params ?? {};
  if (job.kind === 'train' && typeof params.run_id === 'string') {
    return { to: `/models/${params.run_id}`, label: 'Open model' };
  }
  if (job.kind === 'backtest' && typeof params.backtest_id === 'string') {
    return { to: `/backtest?bt=${params.backtest_id}`, label: 'Open backtest' };
  }
  return null;
}

function JobRow({ job }: { job: Job }) {
  const { refresh } = useJobs();
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = isActiveStatus(job.status);
  const end = job.finished_at ?? (active ? Date.now() / 1000 : null);
  const duration = job.started_at && end ? end - job.started_at : null;
  const link = relatedLink(job);

  const cancel = async () => {
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancelJob(job.id);
      await refresh();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <li className="bg-surface">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="group flex min-h-11 min-w-0 flex-1 items-start gap-2.5 rounded-md text-left sm:min-h-0"
        >
          <ChevronRight
            aria-hidden="true"
            strokeWidth={2}
            className={cx('mt-0.5 h-4 w-4 shrink-0 text-fg-subtle transition-transform group-hover:text-fg', open && 'rotate-90')}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">{JOB_KIND_LABEL[job.kind] ?? job.kind}</span>
              <StatusBadge status={job.status} progress={job.progress} />
              <span className="font-mono text-xs text-fg-subtle">{job.id}</span>
            </span>
            {job.message ? <span className="mt-1 block break-words text-xs text-fg-muted">{job.message}</span> : null}
            {job.error ? <span className="mt-1 block break-words text-xs text-negative">{job.error}</span> : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-3 pl-6 text-xs tabular-nums text-fg-subtle sm:pl-0">
          <span title="Created (UTC)">{formatDateTime(job.created_at)}</span>
          <span title="Duration">{duration !== null ? formatDuration(duration) : '—'}</span>
          {link ? (
            <Link to={link.to} className="text-accent-fg hover:underline">
              {link.label}
            </Link>
          ) : null}
          {active ? (
            <Button size="sm" variant="ghost" icon={X} disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : null}
        </div>
        {active ? <ProgressBar value={job.status === 'queued' ? 0 : job.progress} className="basis-full" /> : null}
        {actionError ? <p className="basis-full text-xs text-negative">{actionError}</p> : null}
      </div>
      {open ? <JobLog job={job} /> : null}
    </li>
  );
}

function JobLog({ job }: { job: Job }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = isActiveStatus(job.status);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .jobLog(job.id, 200)
        .then((response) => {
          if (!cancelled) {
            setLines(response.lines);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        });
    };
    load();
    const id = active ? window.setInterval(load, 2000) : undefined;
    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
    };
  }, [job.id, active]);

  useEffect(() => {
    const element = preRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div className="border-t border-line bg-surface-2 px-3.5 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <ScrollText aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5" />
        Log (last 200 lines)
      </p>
      {error ? (
        <p className="text-xs text-negative">{error}</p>
      ) : lines === null ? (
        <Skeleton className="h-20 w-full" />
      ) : lines.length === 0 ? (
        <p className="text-xs text-fg-subtle">No log output yet.</p>
      ) : (
        <pre ref={preRef} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
