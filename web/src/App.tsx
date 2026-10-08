import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Loader2, Moon, Server, Sun } from 'lucide-react';

import { cx } from './components/ui';
import { API_URL } from './lib/api';
import { JOB_KIND_LABEL, useJobs } from './lib/jobs';
import { setTheme, useTheme } from './lib/theme';
import { BacktesterPage } from './pages/BacktesterPage';
import { DataPage } from './pages/DataPage';
import { JobsPage } from './pages/JobsPage';
import { ModelDetailPage } from './pages/ModelDetailPage';
import { ModelsPage } from './pages/ModelsPage';

export default function App() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/data" className="text-[15px] font-semibold tracking-tight text-fg">
              Crypto AI Lab
            </Link>
          </div>

          <div className="order-last -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0 lg:order-none lg:ml-auto">
            <nav aria-label="Main navigation" className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5">
              <SectionLink to="/data">Data</SectionLink>
              <SectionLink to="/models">Models</SectionLink>
              <SectionLink to="/backtest">Backtester</SectionLink>
              <SectionLink to="/jobs">Jobs</SectionLink>
            </nav>
          </div>

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <span className="hidden items-center gap-1.5 text-xs tabular-nums text-fg-subtle xl:inline-flex" title="Backend API">
              <Server aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5" />
              {safeHost(API_URL)}
            </span>
            <RunningJobsIndicator />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/data" replace />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/models/:id" element={<ModelDetailPage />} />
          <Route path="/backtest" element={<BacktesterPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="*" element={<Navigate to="/data" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function RunningJobsIndicator() {
  const { active, error } = useJobs();
  const running = active.find((job) => job.status === 'running') ?? active[0];

  if (error) {
    return (
      <Link
        to="/jobs"
        title={error}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-negative/25 bg-negative/10 px-2.5 text-sm font-medium text-negative sm:h-8"
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-negative" />
        API offline
      </Link>
    );
  }

  return (
    <Link
      to="/jobs"
      title={running ? `${JOB_KIND_LABEL[running.kind]}: ${running.message ?? running.status}` : 'No jobs running'}
      className="inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-sm font-medium tabular-nums text-fg transition-colors hover:bg-surface-3 sm:h-8"
    >
      {running ? (
        <>
          <Loader2 aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-fg" />
          <span className="truncate">
            {JOB_KIND_LABEL[running.kind]}
            {running.status === 'running' ? ` ${Math.round(Math.min(1, Math.max(0, running.progress || 0)) * 100)}%` : ' queued'}
          </span>
          {active.length > 1 ? <span className="shrink-0 text-fg-muted">+{active.length - 1}</span> : null}
        </>
      ) : (
        <>
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-fg-subtle" />
          <span className="text-fg-muted">Idle</span>
        </>
      )}
    </Link>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${nextTheme} mode`;

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      title={label}
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg sm:h-8 sm:w-8"
    >
      {theme === 'dark' ? <Sun aria-hidden="true" strokeWidth={2} className="h-4 w-4" /> : <Moon aria-hidden="true" strokeWidth={2} className="h-4 w-4" />}
    </button>
  );
}

function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'inline-flex h-9 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors sm:h-8',
          isActive ? 'bg-surface-3 text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
        )
      }
    >
      {children}
    </NavLink>
  );
}
