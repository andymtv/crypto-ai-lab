import { formatDate, formatInteger, formatRatio } from './format';
import type { MonthCoverage, SymbolCoverage } from './types';

export type MonthState = 'built' | 'downloaded' | 'absent' | 'outside';

export interface MonthCell {
  month: string; // YYYY-MM
  state: MonthState;
  info: MonthCoverage | null;
  missingRatio: number | null;
  tooltip: string;
}

export interface MonthGrid {
  years: Array<{ year: number; cells: MonthCell[] }>;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function missingRatio(info: MonthCoverage): number | null {
  const expected = (info.rows || 0) + (info.missing_seconds || 0);
  return expected > 0 ? info.missing_seconds / expected : null;
}

// One row per year, 12 cells each, from the symbol's earliest known month to the current UTC
// month.
export function buildMonthGrid(coverage: SymbolCoverage, now: Date = new Date()): MonthGrid {
  const built = new Map(coverage.months.map((month) => [month.month, month]));
  const downloaded = new Set(coverage.downloaded_months);
  const known = [...downloaded, ...built.keys()].sort();
  if (known.length === 0) {
    return { years: [] };
  }
  const first = known[0];
  const last = monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const lastKnown = known[known.length - 1];
  const end = lastKnown > last ? lastKnown : last;
  const firstYear = Number(first.slice(0, 4));
  const endYear = Number(end.slice(0, 4));

  const years: MonthGrid['years'] = [];
  for (let year = firstYear; year <= endYear; year += 1) {
    const cells: MonthCell[] = [];
    for (let month = 1; month <= 12; month += 1) {
      const key = monthKey(year, month);
      const info = built.get(key) ?? null;
      let state: MonthState;
      if (key < first || key > end) state = 'outside';
      else if (info) state = 'built';
      else if (downloaded.has(key)) state = 'downloaded';
      else state = 'absent';
      const ratio = info ? missingRatio(info) : null;
      cells.push({ month: key, state, info, missingRatio: ratio, tooltip: monthTooltip(key, state, info, ratio) });
    }
    years.push({ year, cells });
  }
  return { years };
}

function monthTooltip(month: string, state: MonthState, info: MonthCoverage | null, ratio: number | null): string {
  if (state === 'outside') return month;
  if (state === 'absent') return `${month}: not downloaded`;
  if (state === 'downloaded' || !info) return `${month}: downloaded, not built yet`;
  const parts = [
    `${month}${info.partial ? ' (partial, daily files)' : ''}`,
    `${formatInteger(info.rows)} seconds, ${formatInteger(info.missing_seconds)} missing (${formatRatio(ratio, 3)})`,
    `largest gap ${formatInteger(info.largest_gap_seconds)}s`,
    `${formatDate(info.first_ts)} → ${formatDate(info.last_ts)}`,
  ];
  return parts.join('\n');
}

export function monthCellTone(cell: MonthCell): 'ok' | 'minor' | 'major' | 'pending' | 'absent' | 'future' {
  if (cell.state === 'outside') return 'future';
  if (cell.state === 'absent') return 'absent';
  if (cell.state === 'downloaded') return 'pending';
  const ratio = cell.missingRatio ?? 0;
  if (ratio < 0.001) return 'ok';
  if (ratio <= 0.02) return 'minor';
  return 'major';
}
