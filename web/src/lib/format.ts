// Display formatting. Every helper accepts null/undefined/NaN/Infinity and returns a placeholder
// instead of throwing or printing "NaN"; -0 is normalized to 0.

export const EMPTY = '—';

export function finite(value: number | null | undefined): number | null {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Object.is(value, -0) ? 0 : value;
}

// toFixed can still produce "-0.00" for tiny negatives; strip that sign.
function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

function grouped(value: number, digits: number): string {
  const text = fixed(value, digits);
  const [whole, fraction] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digitsOnly = sign ? whole.slice(1) : whole;
  const withCommas = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${withCommas}${fraction !== undefined ? `.${fraction}` : ''}`;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  const number = finite(value);
  return number === null ? EMPTY : grouped(number, digits);
}

export function formatInteger(value: number | null | undefined): string {
  const number = finite(value);
  return number === null ? EMPTY : grouped(Math.round(number), 0);
}

export function formatCompact(value: number | null | undefined): string {
  const number = finite(value);
  if (number === null) {
    return EMPTY;
  }
  const abs = Math.abs(number);
  if (abs >= 1e9) return `${fixed(number / 1e9, 2)}B`;
  if (abs >= 1e6) return `${fixed(number / 1e6, 2)}M`;
  if (abs >= 1e4) return `${fixed(number / 1e3, 1)}k`;
  return grouped(Math.round(number), 0);
}

// Value already expressed in percent units (backend *_pct fields).
export function formatPercent(
  value: number | null | undefined,
  digits = 2,
  options: { sign?: boolean } = {},
): string {
  const number = finite(value);
  if (number === null) {
    return EMPTY;
  }
  const text = fixed(number, digits);
  const prefix = options.sign && Number(text) > 0 ? '+' : '';
  return `${prefix}${text}%`;
}

// Value is a 0..1 ratio (hit rate, win rate, share of minutes).
export function formatRatio(value: number | null | undefined, digits = 1): string {
  const number = finite(value);
  return number === null ? EMPTY : formatPercent(number * 100, digits);
}

// Quote-currency amounts: 2 decimals normally, 4 for sub-unit values (a 10 USDT account has
// per-trade PnL in cents).
export function formatMoney(value: number | null | undefined, options: { sign?: boolean; unit?: string } = {}): string {
  const number = finite(value);
  if (number === null) {
    return EMPTY;
  }
  const digits = Math.abs(number) < 1 && number !== 0 ? 4 : 2;
  const text = grouped(number, digits);
  const prefix = options.sign && Number(fixed(number, digits)) > 0 ? '+' : '';
  return `${prefix}${text}${options.unit ? ` ${options.unit}` : ''}`;
}

export function formatPrice(value: number | null | undefined): string {
  const number = finite(value);
  if (number === null) {
    return EMPTY;
  }
  const abs = Math.abs(number);
  return grouped(number, abs >= 1000 ? 2 : abs >= 1 ? 3 : 5);
}

export function formatProbability(value: number | null | undefined, digits = 3): string {
  const number = finite(value);
  return number === null ? EMPTY : fixed(number, digits);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toDate(ts: number | null | undefined): Date | null {
  const number = finite(ts);
  if (number === null) {
    return null;
  }
  const date = new Date(number * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

// UTC "YYYY-MM-DD HH:mm" from unix seconds.
export function formatDateTime(ts: number | null | undefined): string {
  const date = toDate(ts);
  if (!date) {
    return EMPTY;
  }
  return `${formatDate(ts)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// UTC "YYYY-MM-DD" from unix seconds.
export function formatDate(ts: number | null | undefined): string {
  const date = toDate(ts);
  if (!date) {
    return EMPTY;
  }
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// "YYYY-MM-DD" (UTC) -> unix seconds at 00:00 UTC, or null when the text is not a valid date.
export function dateInputToTs(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match.map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return ms / 1000;
}

export function formatDuration(seconds: number | null | undefined): string {
  const number = finite(seconds);
  if (number === null || number < 0) {
    return EMPTY;
  }
  const total = Math.round(number);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${pad(total % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${pad(minutes % 60)}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${pad(hours % 24)}h`;
}

// Relative age from a float-seconds timestamp ("3m ago").
export function formatAge(ts: number | null | undefined, now = Date.now() / 1000): string {
  const number = finite(ts);
  if (number === null) {
    return EMPTY;
  }
  const delta = Math.max(0, now - number);
  if (delta < 45) return 'just now';
  return `${formatDuration(delta).split(' ')[0]} ago`;
}

export function signTone(value: number | null | undefined): 'positive' | 'negative' | 'neutral' {
  const number = finite(value);
  if (number === null || Math.abs(number) < 1e-9) {
    return 'neutral';
  }
  return number > 0 ? 'positive' : 'negative';
}
