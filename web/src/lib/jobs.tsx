import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, errorMessage } from './api';
import type { Job, JobKind, JobStatus, RunStatus } from './types';

const ACTIVE_POLL_MS = 2000;
// While nothing runs we only refresh occasionally (and on window focus) to notice jobs started
// from another tab.
const IDLE_POLL_MS = 30000;

export function isActiveStatus(status: JobStatus | RunStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  download: 'Download',
  build_series: 'Build series',
  build_features: 'Build features',
  train: 'Train model',
  backtest: 'Backtest',
};

interface JobsContextValue {
  jobs: Job[];
  loaded: boolean;
  error: string | null;
  active: Job[];
  // Increments whenever a job leaves queued/running; pages refetch on change.
  settledVersion: number;
  refresh: () => Promise<void>;
  byId: (id: string | null | undefined) => Job | undefined;
}

const JobsContext = createContext<JobsContextValue | null>(null);

export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settledVersion, setSettledVersion] = useState(0);
  const previousActive = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const next = await api.jobs(50);
      const nowActive = new Set(next.filter((job) => isActiveStatus(job.status)).map((job) => job.id));
      const settled = [...previousActive.current].some((id) => !nowActive.has(id));
      previousActive.current = nowActive;
      setJobs(next);
      setError(null);
      if (settled) {
        setSettledVersion((version) => version + 1);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  const active = useMemo(() => jobs.filter((job) => isActiveStatus(job.status)), [jobs]);
  const hasActive = active.length > 0;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(id);
  }, [hasActive, refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const byId = useCallback((id: string | null | undefined) => (id ? jobs.find((job) => job.id === id) : undefined), [jobs]);

  const value = useMemo(
    () => ({ jobs, loaded, error, active, settledVersion, refresh, byId }),
    [jobs, loaded, error, active, settledVersion, refresh, byId],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): JobsContextValue {
  const value = useContext(JobsContext);
  if (!value) {
    throw new Error('useJobs must be used inside <JobsProvider>');
  }
  return value;
}

// The freshest copy of a job: the polled list wins over the copy embedded in a record.
export function useLiveJob(job: Job | null | undefined): Job | null {
  const { byId } = useJobs();
  return (job ? byId(job.id) : undefined) ?? job ?? null;
}

// A run/backtest record's status can lag (or stay "running" after a cancel), so the job decides.
export function effectiveStatus(status: RunStatus, job: Job | null): JobStatus | RunStatus {
  if (job && (job.status === 'cancelled' || job.status === 'failed') && status !== 'done') {
    return job.status;
  }
  if (job && isActiveStatus(job.status)) {
    return job.status;
  }
  return status;
}
