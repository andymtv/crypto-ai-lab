import { describe, expect, it } from 'vitest';

import { baseAsset, modelSymbols, pairLabel } from '../symbols';

describe('modelSymbols', () => {
  it('reads multi-coin params', () => {
    expect(modelSymbols({ target_symbol: 'ETHUSDT', context_symbol: null })).toEqual({ target: 'ETHUSDT', context: null });
    expect(modelSymbols({ target_symbol: 'ETHUSDT', context_symbol: 'BTCUSDT' })).toEqual({ target: 'ETHUSDT', context: 'BTCUSDT' });
  });

  it('maps legacy include_btc runs to SOLUSDT with optional BTCUSDT context', () => {
    expect(modelSymbols({ include_btc: true })).toEqual({ target: 'SOLUSDT', context: 'BTCUSDT' });
    expect(modelSymbols({ include_btc: false })).toEqual({ target: 'SOLUSDT', context: null });
  });
});

describe('labels', () => {
  it('formats pairs and base assets', () => {
    expect(pairLabel('ETHUSDT', 'BTCUSDT')).toBe('ETHUSDT + BTCUSDT');
    expect(pairLabel('SOLUSDT', null)).toBe('SOLUSDT only');
    expect(baseAsset('ETHUSDT')).toBe('ETH');
    expect(baseAsset('ETHBTC')).toBe('ETHBTC');
  });
});
