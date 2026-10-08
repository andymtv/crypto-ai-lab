import { describe, expect, it } from 'vitest';

import {
  EMPTY,
  dateInputToTs,
  finite,
  formatCompact,
  formatDate,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRatio,
  signTone,
} from '../format';

describe('finite', () => {
  it('rejects NaN, Infinity, null and undefined and normalizes -0', () => {
    expect(finite(NaN)).toBeNull();
    expect(finite(Infinity)).toBeNull();
    expect(finite(-Infinity)).toBeNull();
    expect(finite(null)).toBeNull();
    expect(finite(undefined)).toBeNull();
    expect(Object.is(finite(-0), 0)).toBe(true);
    expect(finite(1.5)).toBe(1.5);
  });
});

describe('formatPercent', () => {
  it('formats percent-unit values with optional sign', () => {
    expect(formatPercent(12.345)).toBe('12.35%');
    expect(formatPercent(12.345, 1, { sign: true })).toBe('+12.3%');
    expect(formatPercent(-3.2, 2, { sign: true })).toBe('-3.20%');
  });

  it('never prints -0 or NaN', () => {
    expect(formatPercent(-0)).toBe('0.00%');
    expect(formatPercent(-0.0001, 2, { sign: true })).toBe('0.00%');
    expect(formatPercent(0.0001, 2, { sign: true })).toBe('0.00%');
    expect(formatPercent(NaN)).toBe(EMPTY);
    expect(formatPercent(undefined)).toBe(EMPTY);
    expect(formatPercent(Infinity)).toBe(EMPTY);
  });
});

describe('formatRatio', () => {
  it('turns 0..1 ratios into percents', () => {
    expect(formatRatio(0.4567)).toBe('45.7%');
    expect(formatRatio(null)).toBe(EMPTY);
  });
});

describe('formatMoney', () => {
  it('uses 2 decimals normally and 4 for sub-unit amounts', () => {
    expect(formatMoney(1234.567)).toBe('1,234.57');
    expect(formatMoney(0.01234)).toBe('0.0123');
    expect(formatMoney(-0.5)).toBe('-0.5000');
    expect(formatMoney(0)).toBe('0.00');
  });

  it('adds sign and unit, and guards bad values', () => {
    expect(formatMoney(2.5, { sign: true, unit: 'USDT' })).toBe('+2.50 USDT');
    expect(formatMoney(-0)).toBe('0.00');
    expect(formatMoney(-0.00001)).toBe('0.0000');
    expect(formatMoney(NaN)).toBe(EMPTY);
  });
});

describe('number helpers', () => {
  it('groups thousands', () => {
    expect(formatNumber(1234567.891, 2)).toBe('1,234,567.89');
    expect(formatNumber(-1234.5, 1)).toBe('-1,234.5');
    expect(formatInteger(9876543.4)).toBe('9,876,543');
    expect(formatInteger(undefined)).toBe(EMPTY);
  });

  it('compacts large counts', () => {
    expect(formatCompact(190_000_000)).toBe('190.00M');
    expect(formatCompact(25_400)).toBe('25.4k');
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(null)).toBe(EMPTY);
  });

  it('formats prices by magnitude', () => {
    expect(formatPrice(152.4567)).toBe('152.457');
    expect(formatPrice(65000.1)).toBe('65,000.10');
    expect(formatPrice(0.123456)).toBe('0.12346');
  });
});

describe('dates (UTC)', () => {
  it('formats unix seconds in UTC', () => {
    expect(formatDateTime(1704067200)).toBe('2024-01-01 00:00');
    expect(formatDateTime(1704067200 + 13 * 3600 + 5 * 60 + 59)).toBe('2024-01-01 13:05');
    expect(formatDate(1709251199)).toBe('2024-02-29');
    expect(formatDateTime(null)).toBe(EMPTY);
    expect(formatDate(NaN)).toBe(EMPTY);
  });

  it('parses date inputs as UTC midnight and rejects invalid dates', () => {
    expect(dateInputToTs('2024-01-01')).toBe(1704067200);
    expect(dateInputToTs('2024-02-30')).toBeNull();
    expect(dateInputToTs('')).toBeNull();
    expect(dateInputToTs('01/02/2024')).toBeNull();
  });

  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 07m');
    expect(formatDuration(3 * 86400 + 5 * 3600)).toBe('3d 05h');
    expect(formatDuration(-1)).toBe(EMPTY);
  });
});

describe('signTone', () => {
  it('maps sign to tone and treats bad values as neutral', () => {
    expect(signTone(1)).toBe('positive');
    expect(signTone(-1)).toBe('negative');
    expect(signTone(0)).toBe('neutral');
    expect(signTone(NaN)).toBe('neutral');
  });
});
