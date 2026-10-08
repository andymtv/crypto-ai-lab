import { describe, expect, it } from 'vitest';

import { pickTimeframe, toLineData, tradeMarkers } from '../chartData';
import type { Trade } from '../types';

describe('pickTimeframe', () => {
  it('picks the smallest timeframe within the candle budget', () => {
    expect(pickTimeframe(0, 86400)).toBe('1m');
    expect(pickTimeframe(0, 20 * 86400)).toBe('15m');
    expect(pickTimeframe(0, 30 * 86400)).toBe('1h');
    expect(pickTimeframe(0, 365 * 86400)).toBe('4h');
    expect(pickTimeframe(0, 6 * 365 * 86400)).toBe('1d');
  });
});

describe('toLineData', () => {
  it('sorts, dedupes by second and drops non-finite points', () => {
    const points = [
      { t: 30, v: 3 },
      { t: 10, v: 1 },
      { t: 30, v: 4 },
      { t: 20, v: NaN },
      { t: 25.7, v: 2 },
    ];
    expect(toLineData(points, (p) => p.t, (p) => p.v)).toEqual([
      { time: 10, value: 1 },
      { time: 25, value: 2 },
      { time: 30, value: 4 },
    ]);
    expect(toLineData(null, () => 0, () => 0)).toEqual([]);
  });
});

describe('tradeMarkers', () => {
  const trade = (entry: number, exit: number, outcome: number): Trade => ({
    entry_ts: entry,
    exit_ts: exit,
    entry_price: 100,
    exit_price: 101,
    quantity: 0.1,
    pnl: 0.1,
    fees: 0.02,
    outcome,
    prob: 0.7,
    equity_after: 10.1,
  });

  it('snaps to candle times, sorts, and keeps only the most recent trades', () => {
    const trades = [trade(7200 + 100, 7200 + 4000, -1), trade(100, 500, 1), trade(3700, 3800, 0)];
    const { markers, shownTrades } = tradeMarkers(trades, 3600, 2);
    expect(shownTrades).toBe(2);
    expect(markers.map((marker) => [marker.time, marker.kind])).toEqual([
      [3600, 'entry'],
      [3600, 'timeout'],
      [7200, 'entry'],
      [10800, 'sl'],
    ]);
  });
});
