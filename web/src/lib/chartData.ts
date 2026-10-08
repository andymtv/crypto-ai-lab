import { finite } from './format';
import type { Timeframe, Trade } from './types';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const TIMEFRAME_ORDER: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Smallest timeframe whose candle count over [start, end) stays within maxCandles
// (the API returns at most 5000 candles).
export function pickTimeframe(start: number, end: number, maxCandles = 2500): Timeframe {
  const span = Math.max(0, end - start);
  for (const tf of TIMEFRAME_ORDER) {
    if (span / TIMEFRAME_SECONDS[tf] <= maxCandles) {
      return tf;
    }
  }
  return '1d';
}

export interface TimeValue {
  time: number;
  value: number;
}

// lightweight-charts needs strictly ascending, unique times and finite values.
export function toLineData<T>(points: T[] | null | undefined, time: (point: T) => number, value: (point: T) => number): TimeValue[] {
  if (!points || points.length === 0) {
    return [];
  }
  const byTime = new Map<number, number>();
  for (const point of points) {
    const t = finite(time(point));
    const v = finite(value(point));
    if (t === null || v === null) {
      continue;
    }
    byTime.set(Math.floor(t), v); // later points at the same second win
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t, value: v }));
}

export type MarkerKind = 'entry' | 'tp' | 'sl' | 'timeout';

export interface TradeMarker {
  time: number;
  kind: MarkerKind;
  price: number;
}

export function outcomeKind(outcome: number): Exclude<MarkerKind, 'entry'> {
  return outcome === 1 ? 'tp' : outcome === -1 ? 'sl' : 'timeout';
}

export function outcomeLabel(outcome: number): string {
  return outcome === 1 ? 'TP' : outcome === -1 ? 'SL' : 'Timeout';
}

// Entry/exit markers snapped to candle times, for the most recent `maxTrades` trades.
export function tradeMarkers(
  trades: Trade[],
  tfSeconds: number,
  maxTrades: number,
): { markers: TradeMarker[]; shownTrades: number } {
  const sorted = [...trades].sort((a, b) => a.entry_ts - b.entry_ts);
  const shown = sorted.slice(Math.max(0, sorted.length - maxTrades));
  const snap = (ts: number) => Math.floor(ts / tfSeconds) * tfSeconds;
  const markers: TradeMarker[] = [];
  for (const trade of shown) {
    if (finite(trade.entry_ts) === null || finite(trade.exit_ts) === null) {
      continue;
    }
    markers.push({ time: snap(trade.entry_ts), kind: 'entry', price: trade.entry_price });
    markers.push({ time: snap(trade.exit_ts), kind: outcomeKind(trade.outcome), price: trade.exit_price });
  }
  markers.sort((a, b) => a.time - b.time);
  return { markers, shownTrades: shown.length };
}
