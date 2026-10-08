import { dateInputToTs, formatDate, formatMoney, formatPercent } from './format';
import type { BacktestParams, BacktestRequest, ModelRun, Sizing, SweepRequest } from './types';

// Fallback minimum order value until the traded coin's Binance filter is known.
export const MIN_NOTIONAL_DEFAULT = 5;
const DAY_SECONDS = 86400;

// Inputs are kept as text so half-typed values ("0.", "") survive re-renders.
export interface BacktestFormState {
  name: string;
  modelRunId: string;
  startDate: string; // YYYY-MM-DD (UTC), inclusive
  endDate: string; // YYYY-MM-DD (UTC), inclusive
  threshold: string;
  tpPct: string;
  slPct: string;
  maxHoldMinutes: string;
  feePct: string;
  slippageBps: string;
  latencySeconds: string;
  initialCapital: string;
  sizing: Sizing;
  orderQuote: string;
  compoundFraction: string;
  minNotional: string;
  cooldownMinutes: string;
}

export type IssueSeverity = 'error' | 'warning';

export interface FormIssue {
  field: keyof BacktestFormState | 'sweep';
  severity: IssueSeverity;
  message: string;
}

export function emptyBacktestForm(): BacktestFormState {
  return {
    name: '',
    modelRunId: '',
    startDate: '',
    endDate: '',
    threshold: '0.6',
    tpPct: '0.6',
    slPct: '0.4',
    maxHoldMinutes: '60',
    feePct: '0.1',
    slippageBps: '2',
    latencySeconds: '1',
    initialCapital: '10',
    sizing: 'compound',
    orderQuote: '10',
    compoundFraction: '1',
    minNotional: String(MIN_NOTIONAL_DEFAULT),
    cooldownMinutes: '0',
  };
}

// Model-dependent defaults: OOF date range and the label's exit settings.
export function formDefaultsForModel(run: ModelRun): Pick<
  BacktestFormState,
  'modelRunId' | 'startDate' | 'endDate' | 'tpPct' | 'slPct' | 'maxHoldMinutes' | 'latencySeconds'
> {
  const label = run.params.label;
  return {
    modelRunId: run.id,
    startDate: run.metrics ? formatDate(run.metrics.oof_start) : '',
    endDate: run.metrics ? formatDate(run.metrics.oof_end) : '',
    tpPct: String(label.tp_pct),
    slPct: String(label.sl_pct),
    maxHoldMinutes: String(label.horizon_minutes),
    latencySeconds: String(label.latency_seconds),
  };
}

export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// Quote size of the first order before fees (fixed sizing is capped by equity, like the engine).
export function firstOrderQuote(sizing: Sizing, initialCapital: number, orderQuote: number, compoundFraction: number): number {
  return sizing === 'fixed' ? Math.min(orderQuote, initialCapital) : initialCapital * compoundFraction;
}

export interface ValidatedBacktest {
  issues: FormIssue[];
  request: BacktestRequest | null;
}

interface RangeRule {
  field: keyof BacktestFormState;
  label: string;
  min: number;
  max?: number;
  minExclusive?: boolean;
  integer?: boolean;
}

// Mirrors the pydantic Field bounds of BacktestRequest.
const RULES: RangeRule[] = [
  { field: 'threshold', label: 'Threshold', min: 0, max: 1 },
  { field: 'tpPct', label: 'Take profit', min: 0, max: 50, minExclusive: true },
  { field: 'slPct', label: 'Stop loss', min: 0, max: 50, minExclusive: true },
  { field: 'maxHoldMinutes', label: 'Max hold', min: 1, max: 10080, integer: true },
  { field: 'feePct', label: 'Fee', min: 0, max: 1 },
  { field: 'slippageBps', label: 'Slippage', min: 0, max: 100 },
  { field: 'latencySeconds', label: 'Latency', min: 0, max: 60, integer: true },
  { field: 'initialCapital', label: 'Initial capital', min: 0, minExclusive: true },
  { field: 'orderQuote', label: 'Order size', min: 0, minExclusive: true },
  { field: 'compoundFraction', label: 'Compound fraction', min: 0, max: 1, minExclusive: true },
  { field: 'minNotional', label: 'Min notional', min: 0 },
  { field: 'cooldownMinutes', label: 'Cooldown', min: 0, max: 1440, integer: true },
];

export function validateBacktestForm(state: BacktestFormState): ValidatedBacktest {
  const issues: FormIssue[] = [];
  const values: Partial<Record<keyof BacktestFormState, number>> = {};

  if (!state.modelRunId) {
    issues.push({ field: 'modelRunId', severity: 'error', message: 'Choose a trained model.' });
  }

  for (const rule of RULES) {
    const value = parseNumber(state[rule.field] as string);
    if (value === null) {
      issues.push({ field: rule.field, severity: 'error', message: `${rule.label} must be a number.` });
      continue;
    }
    const belowMin = rule.minExclusive ? value <= rule.min : value < rule.min;
    const aboveMax = rule.max !== undefined && value > rule.max;
    if (belowMin || aboveMax) {
      const lower = rule.minExclusive ? `greater than ${rule.min}` : `at least ${rule.min}`;
      const upper = rule.max !== undefined ? ` and at most ${rule.max}` : '';
      issues.push({ field: rule.field, severity: 'error', message: `${rule.label} must be ${lower}${upper}.` });
      continue;
    }
    if (rule.integer && !Number.isInteger(value)) {
      issues.push({ field: rule.field, severity: 'error', message: `${rule.label} must be a whole number.` });
      continue;
    }
    values[rule.field] = value;
  }

  const startTs = state.startDate ? dateInputToTs(state.startDate) : null;
  const endDay = state.endDate ? dateInputToTs(state.endDate) : null;
  if (state.startDate && startTs === null) {
    issues.push({ field: 'startDate', severity: 'error', message: 'Start date is not a valid date.' });
  }
  if (state.endDate && endDay === null) {
    issues.push({ field: 'endDate', severity: 'error', message: 'End date is not a valid date.' });
  }
  const endTs = endDay === null ? null : endDay + DAY_SECONDS; // inclusive end day
  if (startTs !== null && endTs !== null && startTs >= endTs) {
    issues.push({ field: 'endDate', severity: 'error', message: 'End date must not be before the start date.' });
  }

  const capital = values.initialCapital;
  const minNotional = values.minNotional;
  const fee = values.feePct;
  if (capital !== undefined && minNotional !== undefined && fee !== undefined) {
    const quote = firstOrderQuote(state.sizing, capital, values.orderQuote ?? 0, values.compoundFraction ?? 0);
    const sizingFieldOk = state.sizing === 'fixed' ? values.orderQuote !== undefined : values.compoundFraction !== undefined;
    // The engine buys floor(quote / (price * (1 + fee))) units; notional ~ quote / (1 + fee).
    const notional = quote / (1 + fee / 100);
    if (sizingFieldOk && notional < minNotional) {
      const field = state.sizing === 'fixed' ? 'orderQuote' : 'compoundFraction';
      const how =
        state.sizing === 'fixed'
          ? values.orderQuote !== undefined && values.orderQuote > capital
            ? `the order is capped by the ${formatMoney(capital)} USDT capital`
            : `order size is ${formatMoney(values.orderQuote)} USDT`
          : `${formatMoney(capital)} × ${values.compoundFraction} = ${formatMoney(quote)} USDT`;
      issues.push({
        field,
        severity: 'error',
        message: `Order size is below the ${formatMoney(minNotional)} USDT minimum notional (${how}); every signal would be skipped.`,
      });
    } else if (sizingFieldOk && minNotional > 0 && notional < minNotional * 1.5) {
      const headroom = (1 - minNotional / notional) * 100;
      issues.push({
        field: state.sizing === 'fixed' ? 'orderQuote' : 'compoundFraction',
        severity: 'warning',
        message: `Orders fall below the ${formatMoney(minNotional)} USDT minimum after a ${formatPercent(headroom, 0)} drawdown; later signals would be skipped.`,
      });
    }
  }

  const tp = values.tpPct;
  const slippage = values.slippageBps;
  if (tp !== undefined && fee !== undefined) {
    const roundTrip = 2 * fee + (slippage ?? 0) / 100;
    if (tp <= roundTrip) {
      issues.push({
        field: 'tpPct',
        severity: 'warning',
        message: `Take profit ${formatPercent(tp)} does not cover round-trip costs (${formatPercent(2 * fee)} fees + ${formatPercent((slippage ?? 0) / 100)} entry slippage = ${formatPercent(roundTrip)}); winning trades lose money.`,
      });
    }
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError) {
    return { issues, request: null };
  }

  const request: BacktestRequest = {
    model_run_id: state.modelRunId,
    threshold: values.threshold!,
    tp_pct: values.tpPct!,
    sl_pct: values.slPct!,
    max_hold_minutes: values.maxHoldMinutes!,
    fee_pct: values.feePct!,
    slippage_bps: values.slippageBps!,
    latency_seconds: values.latencySeconds!,
    initial_capital: values.initialCapital!,
    sizing: state.sizing,
    order_quote: values.orderQuote!,
    compound_fraction: values.compoundFraction!,
    min_notional: values.minNotional!,
    cooldown_minutes: values.cooldownMinutes!,
  };
  if (state.name.trim()) request.name = state.name.trim();
  if (startTs !== null) request.start_ts = startTs;
  if (endTs !== null) request.end_ts = endTs;
  return { issues, request };
}

// "0.5, 0.55 0.6" -> [0.5, 0.55, 0.6]; deduplicated and sorted.
export function parseThresholdList(text: string): { values: number[]; error: string | null } {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) {
    return { values: [], error: 'Enter at least one threshold.' };
  }
  const values: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { values: [], error: `"${part}" is not a threshold between 0 and 1.` };
    }
    values.push(value);
  }
  return { values: [...new Set(values)].sort((a, b) => a - b), error: null };
}

// "0.6/0.4, 0.8/0.5" -> [[0.6, 0.4], [0.8, 0.5]].
export function parseTpSlPairs(text: string): { values: Array<[number, number]>; error: string | null } {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) {
    return { values: [], error: 'Enter at least one TP/SL pair, e.g. 0.6/0.4.' };
  }
  const values: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const match = /^([0-9]*\.?[0-9]+)\/([0-9]*\.?[0-9]+)$/.exec(part);
    const tp = match ? Number(match[1]) : NaN;
    const sl = match ? Number(match[2]) : NaN;
    if (!match || !(tp > 0 && tp <= 50) || !(sl > 0 && sl <= 50)) {
      return { values: [], error: `"${part}" is not a TP/SL pair like 0.6/0.4 (percent, each 0-50).` };
    }
    const key = `${tp}/${sl}`;
    if (!seen.has(key)) {
      seen.add(key);
      values.push([tp, sl]);
    }
  }
  return { values, error: null };
}

export const MAX_SWEEP_COMBINATIONS = 120;

export function buildSweepRequest(
  base: BacktestRequest,
  thresholdsText: string,
  pairsText: string,
): { request: SweepRequest | null; error: string | null } {
  const thresholds = parseThresholdList(thresholdsText);
  if (thresholds.error) return { request: null, error: thresholds.error };
  const pairs = parseTpSlPairs(pairsText);
  if (pairs.error) return { request: null, error: pairs.error };
  const combinations = thresholds.values.length * pairs.values.length;
  if (combinations > MAX_SWEEP_COMBINATIONS) {
    return {
      request: null,
      error: `${combinations} combinations is too many; keep it at ${MAX_SWEEP_COMBINATIONS} or fewer.`,
    };
  }
  return { request: { ...base, thresholds: thresholds.values, tp_sl_pairs: pairs.values }, error: null };
}

// Restores a saved backtest's settings into the form (dates left blank mean "model OOF range").
export function formFromParams(params: BacktestParams): BacktestFormState {
  return {
    name: '',
    modelRunId: params.model_run_id,
    startDate: params.start_ts !== null && params.start_ts !== undefined ? formatDate(params.start_ts) : '',
    endDate: params.end_ts !== null && params.end_ts !== undefined ? formatDate(params.end_ts - 1) : '',
    threshold: String(params.threshold),
    tpPct: String(params.tp_pct),
    slPct: String(params.sl_pct),
    maxHoldMinutes: String(params.max_hold_minutes),
    feePct: String(params.fee_pct),
    slippageBps: String(params.slippage_bps),
    latencySeconds: String(params.latency_seconds),
    initialCapital: String(params.initial_capital),
    sizing: params.sizing,
    orderQuote: String(params.order_quote),
    compoundFraction: String(params.compound_fraction),
    minNotional: String(params.min_notional),
    cooldownMinutes: String(params.cooldown_minutes),
  };
}

// The threshold-table row describing a threshold: the highest row at or below it.
export function thresholdRowFor<T extends { threshold: number }>(rows: T[] | null | undefined, threshold: number | null): T | null {
  if (!rows || rows.length === 0 || threshold === null) return null;
  let best: T | null = null;
  for (const row of rows) {
    if (row.threshold <= threshold + 1e-9 && (!best || row.threshold > best.threshold)) {
      best = row;
    }
  }
  return best;
}
