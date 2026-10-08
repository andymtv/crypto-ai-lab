import type {
  Backtest,
  BacktestDetail,
  BacktestRequest,
  CandlesResponse,
  DataStatus,
  FeatureMeta,
  Job,
  ModelRun,
  ModelRunDetail,
  SweepRequest,
  SymbolInfo,
  Timeframe,
  TradesResponse,
  TrainRequest,
} from './types';

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8100').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// FastAPI errors: {"detail": "text"} or {"detail": [{loc, msg}, ...]} for validation failures.
export function describeApiDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) {
    return detail;
  }
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) {
          const loc = Array.isArray((item as { loc?: unknown }).loc)
            ? ((item as { loc: unknown[] }).loc.filter((part) => part !== 'body').join('.'))
            : '';
          return loc ? `${loc}: ${String((item as { msg: unknown }).msg)}` : String((item as { msg: unknown }).msg);
        }
        return String(item);
      })
      .join('; ');
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    });
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_URL}`, 0);
  }
  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = ((await response.json()) as { detail?: unknown }).detail;
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(describeApiDetail(detail, `${response.status} ${response.statusText}`), response.status);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const api = {
  // Data
  dataStatus: () => request<DataStatus>('/api/data/status'),
  // The backend defaults a missing context to BTCUSDT; an empty value means "no context coin".
  features: (target: string, context: string | null) =>
    request<FeatureMeta>(
      `/api/data/features?target=${encodeURIComponent(target)}&context=${encodeURIComponent(context ?? '')}`,
    ),
  validateSymbol: (symbol: string) => request<SymbolInfo>(`/api/data/symbols/validate${query({ symbol })}`),
  startDownload: (symbols: string[], startMonth?: string) =>
    post<Job>('/api/data/download', startMonth ? { symbols, start_month: startMonth } : { symbols }),
  startBuild: (symbols: string[]) => post<Job>('/api/data/build', { symbols }),
  startFeatures: (target: string, context: string | null) => post<Job>('/api/data/features', { target, context }),
  candles: (symbol: string, tf: Timeframe, start?: number, end?: number) =>
    request<CandlesResponse>(`/api/market/candles${query({ symbol, tf, start, end })}`),

  // Models
  models: (target?: string) => request<ModelRun[]>(`/api/models${query({ target })}`),
  model: (id: string) => request<ModelRunDetail>(`/api/models/${encodeURIComponent(id)}`),
  trainModel: (body: TrainRequest) => post<ModelRun>('/api/models', body),
  deleteModel: (id: string) => del<{ deleted: string }>(`/api/models/${encodeURIComponent(id)}`),

  // Backtests
  backtests: () => request<Backtest[]>('/api/backtests'),
  backtest: (id: string) => request<BacktestDetail>(`/api/backtests/${encodeURIComponent(id)}`),
  trades: (id: string, limit = 5000) =>
    request<TradesResponse>(`/api/backtests/${encodeURIComponent(id)}/trades${query({ limit })}`),
  runBacktest: (body: BacktestRequest) => post<Backtest>('/api/backtests', body),
  runSweep: (body: SweepRequest) => post<Backtest>('/api/backtests/sweep', body),
  deleteBacktest: (id: string) => del<{ deleted: string }>(`/api/backtests/${encodeURIComponent(id)}`),

  // Jobs
  jobs: (limit = 50) => request<Job[]>(`/api/jobs${query({ limit })}`),
  jobLog: (id: string, tail = 200) => request<{ lines: string[] }>(`/api/jobs/${encodeURIComponent(id)}/log${query({ tail })}`),
  cancelJob: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`),
};
