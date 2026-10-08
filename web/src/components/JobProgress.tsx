import { useState } from 'react';
import { X } from 'lucide-react';

import { api, errorMessage } from '../lib/api';
import { formatDuration } from '../lib/format';
import { JOB_KIND_LABEL, isActiveStatus, useJobs } from '../lib/jobs';
import type { Job } from '../lib/types';
import { Button, ProgressBar, StatusBadge, cx } from './ui';

// Compact live view of one job: status, progress, message, elapsed time and a cancel button.
export function JobProgress({ job, className, showKind = true }: { job: Job; className?: string; showKind?: boolean }) {
  const { refresh } = useJobs();
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const active = isActiveStatus(job.status);
  const end = job.finished_at ?? Date.now() / 1000;
  const elapsed = job.started_at ? end - job.started_at : null;

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelJob(job.id);
      await refresh();
    } catch (cause) {
      setCancelError(errorMessage(cause));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className={cx('rounded-lg border border-line bg-surface-2 px-3.5 py-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {showKind ? <span className="text-sm font-medium text-fg">{JOB_KIND_LABEL[job.kind] ?? job.kind}</span> : null}
        <StatusBadge status={job.status} progress={job.progress} />
        {elapsed !== null ? <span className="text-xs tabular-nums text-fg-subtle">{formatDuration(elapsed)}</span> : null}
        {active ? (
          <Button size="sm" variant="ghost" icon={X} className="ml-auto" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        ) : null}
      </div>
      {active ? <ProgressBar value={job.status === 'queued' ? 0 : job.progress} className="mt-2.5" /> : null}
      {job.message ? <p className="mt-1.5 break-words text-xs text-fg-muted">{job.message}</p> : null}
      {job.error ? <p className="mt-1.5 break-words text-xs text-negative">{job.error}</p> : null}
      {cancelError ? <p className="mt-1.5 text-xs text-negative">{cancelError}</p> : null}
    </div>
  );
}
