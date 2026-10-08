import { describe, expect, it } from 'vitest';

import { buildMonthGrid, monthCellTone } from '../coverage';
import type { SymbolCoverage } from '../types';

const base: SymbolCoverage = {
  symbol: 'SOLUSDT',
  downloaded_months: [],
  built_months: [],
  months: [],
  length_seconds: 0,
  first_ts: null,
  last_ts: null,
  missing_seconds: 0,
  bars_built: false,
  bars_updated_at: null,
};

describe('buildMonthGrid', () => {
  it('is empty before anything is downloaded', () => {
    expect(buildMonthGrid(base).years).toEqual([]);
  });

  it('classifies months by download/build state and missing ratio', () => {
    const coverage: SymbolCoverage = {
      ...base,
      downloaded_months: ['2020-08', '2020-09', '2020-10'],
      built_months: ['2020-08', '2020-09'],
      months: [
        { month: '2020-08', rows: 999_000, first_ts: 0, last_ts: 1, missing_seconds: 1_000, largest_gap_seconds: 30, partial: false },
        { month: '2020-09', rows: 900_000, first_ts: 0, last_ts: 1, missing_seconds: 100_000, largest_gap_seconds: 3000, partial: true },
      ],
    };
    const grid = buildMonthGrid(coverage, new Date(Date.UTC(2021, 1, 15)));
    expect(grid.years.map((year) => year.year)).toEqual([2020, 2021]);
    const cells = grid.years[0].cells;
    expect(monthCellTone(cells[0])).toBe('future'); // 2020-01: before the first known month
    expect(monthCellTone(cells[7])).toBe('minor'); // 0.1% missing
    expect(monthCellTone(cells[8])).toBe('major'); // 10% missing
    expect(cells[8].tooltip).toMatch(/partial/);
    expect(monthCellTone(cells[9])).toBe('pending');
    expect(monthCellTone(cells[10])).toBe('absent');
    expect(monthCellTone(grid.years[1].cells[1])).toBe('absent'); // 2021-02 current month
    expect(monthCellTone(grid.years[1].cells[2])).toBe('future');
  });
});
