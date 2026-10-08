import type { ModelParams, SymbolCoverage } from './types';

// Defaults only: any Binance USDT pair with 1s archives can be added on the Data page.
export const DEFAULT_TARGET = 'SOLUSDT';
export const DEFAULT_CONTEXT = 'BTCUSDT';

export const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;

export function normalizeSymbol(text: string): string {
  return text.trim().toUpperCase();
}

// Target/context of a model run. Runs from before multi-coin support traded SOLUSDT with
// BTCUSDT as optional context (include_btc).
export function modelSymbols(params: Pick<ModelParams, 'target_symbol' | 'context_symbol' | 'include_btc'>): {
  target: string;
  context: string | null;
} {
  const target = params.target_symbol ?? DEFAULT_TARGET;
  const context = params.context_symbol !== undefined ? params.context_symbol : params.include_btc === false ? null : DEFAULT_CONTEXT;
  return { target, context };
}

export function pairLabel(target: string, context: string | null): string {
  return context ? `${target} + ${context}` : `${target} only`;
}

// Base asset for display ("SOLUSDT" -> "SOL").
export function baseAsset(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

// Symbols whose 1m bars exist (usable for features / training).
export function symbolsWithBars(coverage: SymbolCoverage[] | null | undefined): string[] {
  return (coverage ?? []).filter((item) => item.bars_built).map((item) => item.symbol);
}
