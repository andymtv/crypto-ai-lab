import { describe, expect, it } from 'vitest';

import {
  buildSweepRequest,
  emptyBacktestForm,
  firstOrderQuote,
  formFromParams,
  parseThresholdList,
  parseTpSlPairs,
  thresholdRowFor,
  validateBacktestForm,
  type BacktestFormState,
} from '../backtestForm';
import type { BacktestParams } from '../types';

function form(overrides: Partial<BacktestFormState> = {}): BacktestFormState {
  return { ...emptyBacktestForm(), modelRunId: 'run1', ...overrides };
}

const errors = (state: BacktestFormState) => validateBacktestForm(state).issues.filter((issue) => issue.severity === 'error');
const warnings = (state: BacktestFormState) => validateBacktestForm(state).issues.filter((issue) => issue.severity === 'warning');

describe('validateBacktestForm', () => {
  it('accepts the defaults and builds the request', () => {
    const result = validateBacktestForm(form());
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.request).toMatchObject({
      model_run_id: 'run1',
      threshold: 0.6,
      tp_pct: 0.6,
      sl_pct: 0.4,
      fee_pct: 0.1,
      initial_capital: 10,
      sizing: 'compound',
      min_notional: 5,
    });
    expect(result.request?.start_ts).toBeUndefined();
  });

  it('requires a model', () => {
    expect(errors(form({ modelRunId: '' })).map((issue) => issue.field)).toContain('modelRunId');
  });

  it('blocks compound sizing whose first order is below min notional', () => {
    const issues = errors(form({ initialCapital: '10', compoundFraction: '0.4' }));
    expect(issues.find((issue) => issue.field === 'compoundFraction')?.message).toMatch(/below the 5\.00 USDT minimum/);
    expect(validateBacktestForm(form({ compoundFraction: '0.4' })).request).toBeNull();
  });

  it('blocks fixed sizing below min notional, including when capped by capital', () => {
    expect(errors(form({ sizing: 'fixed', orderQuote: '4' })).some((issue) => issue.field === 'orderQuote')).toBe(true);
    const capped = errors(form({ sizing: 'fixed', orderQuote: '50', initialCapital: '4' }));
    expect(capped.find((issue) => issue.field === 'orderQuote')?.message).toMatch(/capped by/);
  });

  it('accounts for the buy fee when comparing with min notional', () => {
    // 5 USDT quote buys 5 / 1.001 notional, just under the 5 USDT floor.
    expect(errors(form({ sizing: 'fixed', orderQuote: '5', initialCapital: '100' })).some((issue) => issue.field === 'orderQuote')).toBe(true);
    expect(errors(form({ sizing: 'fixed', orderQuote: '5.1', initialCapital: '100' }))).toEqual([]);
  });

  it('warns when little drawdown headroom remains above min notional', () => {
    expect(warnings(form({ initialCapital: '6' })).some((issue) => /drawdown/.test(issue.message))).toBe(true);
    expect(warnings(form({ initialCapital: '100' })).some((issue) => /drawdown/.test(issue.message))).toBe(false);
  });

  it('warns when take profit does not cover round-trip costs', () => {
    const tp = warnings(form({ tpPct: '0.2', feePct: '0.1' }));
    expect(tp.find((issue) => issue.field === 'tpPct')?.message).toMatch(/does not cover round-trip costs/);
    expect(warnings(form({ tpPct: '0.6', feePct: '0.1' })).some((issue) => issue.field === 'tpPct')).toBe(false);
    // Still runnable: it is a warning.
    expect(validateBacktestForm(form({ tpPct: '0.2' })).request).not.toBeNull();
  });

  it('enforces backend bounds and numeric input', () => {
    expect(errors(form({ threshold: '1.2' })).some((issue) => issue.field === 'threshold')).toBe(true);
    expect(errors(form({ tpPct: '0' })).some((issue) => issue.field === 'tpPct')).toBe(true);
    expect(errors(form({ maxHoldMinutes: '1.5' })).some((issue) => issue.field === 'maxHoldMinutes')).toBe(true);
    expect(errors(form({ feePct: '' })).some((issue) => issue.field === 'feePct')).toBe(true);
    expect(errors(form({ slippageBps: 'abc' })).some((issue) => issue.field === 'slippageBps')).toBe(true);
  });

  it('turns the inclusive date range into [start, end) seconds', () => {
    const result = validateBacktestForm(form({ startDate: '2024-01-01', endDate: '2024-01-31' }));
    expect(result.request?.start_ts).toBe(1704067200);
    expect(result.request?.end_ts).toBe(1704067200 + 31 * 86400);
    expect(errors(form({ startDate: '2024-02-01', endDate: '2024-01-31' })).some((issue) => issue.field === 'endDate')).toBe(true);
  });
});

describe('firstOrderQuote', () => {
  it('matches the engine sizing', () => {
    expect(firstOrderQuote('compound', 10, 99, 0.5)).toBe(5);
    expect(firstOrderQuote('fixed', 10, 25, 1)).toBe(10);
    expect(firstOrderQuote('fixed', 100, 25, 1)).toBe(25);
  });
});

describe('sweep parsing', () => {
  it('parses, sorts and dedupes thresholds', () => {
    expect(parseThresholdList('0.7, 0.5 0.6;0.5')).toEqual({ values: [0.5, 0.6, 0.7], error: null });
    expect(parseThresholdList('0.5, 1.5').error).toMatch(/1\.5/);
    expect(parseThresholdList('  ').error).toBeTruthy();
  });

  it('parses TP/SL pairs', () => {
    expect(parseTpSlPairs('0.6/0.4, 0.9/0.4 0.6/0.4')).toEqual({ values: [[0.6, 0.4], [0.9, 0.4]], error: null });
    expect(parseTpSlPairs('0.6-0.4').error).toMatch(/0\.6-0\.4/);
    expect(parseTpSlPairs('0/0.4').error).toBeTruthy();
  });

  it('builds a sweep request and caps the combination count', () => {
    const base = validateBacktestForm(form()).request!;
    const ok = buildSweepRequest(base, '0.5, 0.6', '0.6/0.4');
    expect(ok.request?.thresholds).toEqual([0.5, 0.6]);
    expect(ok.request?.tp_sl_pairs).toEqual([[0.6, 0.4]]);
    const thresholds = Array.from({ length: 21 }, (_, i) => (0.3 + i * 0.03).toFixed(2)).join(',');
    const pairs = Array.from({ length: 6 }, (_, i) => `${0.5 + i * 0.1}/0.4`).join(',');
    expect(buildSweepRequest(base, thresholds, pairs).error).toMatch(/too many/);
  });
});

describe('formFromParams / thresholdRowFor', () => {
  it('restores a saved backtest with inclusive end date', () => {
    const params = {
      model_run_id: 'abc',
      start_ts: 1704067200,
      end_ts: 1704067200 + 31 * 86400,
      threshold: 0.65,
      tp_pct: 0.8,
      sl_pct: 0.5,
      max_hold_minutes: 90,
      fee_pct: 0.075,
      slippage_bps: 2,
      latency_seconds: 1,
      initial_capital: 50,
      sizing: 'fixed',
      order_quote: 20,
      compound_fraction: 1,
      min_notional: 5,
      cooldown_minutes: 3,
    } as BacktestParams;
    const restored = formFromParams(params);
    expect(restored.startDate).toBe('2024-01-01');
    expect(restored.endDate).toBe('2024-01-31');
    expect(restored.sizing).toBe('fixed');
    expect(validateBacktestForm(restored).request).toMatchObject({ start_ts: params.start_ts, end_ts: params.end_ts, threshold: 0.65 });
  });

  it('picks the highest table row at or below the threshold', () => {
    const rows = [0.3, 0.35, 0.4].map((threshold) => ({ threshold }));
    expect(thresholdRowFor(rows, 0.37)?.threshold).toBe(0.35);
    expect(thresholdRowFor(rows, 0.4)?.threshold).toBe(0.4);
    expect(thresholdRowFor(rows, 0.2)).toBeNull();
    expect(thresholdRowFor(null, 0.5)).toBeNull();
  });
});
