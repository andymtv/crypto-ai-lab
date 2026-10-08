import { useSyncExternalStore } from 'react';

// Light/dark theme. The resolved theme lives on <html data-theme="..."> so the CSS tokens in
// index.css switch; index.html applies the stored value before first paint to avoid a flash.

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'crypto-ai-lab.theme';
export const DEFAULT_THEME: Theme = 'dark';

export function parseTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
}

function readDocumentTheme(): Theme {
  if (typeof document === 'undefined') {
    return DEFAULT_THEME;
  }

  return parseTheme(document.documentElement.dataset.theme);
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode); the theme still applies for this visit.
  }

  for (const listener of listeners) {
    listener();
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readDocumentTheme, () => DEFAULT_THEME);
}

// Canvas/SVG charts cannot read Tailwind classes, so they take concrete colors from here.
// Keep in sync with the tokens in index.css.
export interface ChartPalette {
  positive: string;
  negative: string;
  warning: string;
  accent: string;
  neutral: string;
  subtle: string;
  fg: string;
  surface: string;
  grid: string;
  border: string;
  zeroLine: string;
  crosshair: string;
  crosshairLabel: string;
  series: string[];
}

export const CHART_PALETTES: Record<Theme, ChartPalette> = {
  dark: {
    positive: '#34d399',
    negative: '#f87171',
    warning: '#fbbf24',
    accent: '#60a5fa',
    neutral: '#a1a1aa',
    subtle: '#71717a',
    fg: '#f4f4f5',
    surface: '#111113',
    grid: 'rgba(255, 255, 255, 0.06)',
    border: 'rgba(255, 255, 255, 0.08)',
    zeroLine: 'rgba(255, 255, 255, 0.12)',
    crosshair: 'rgba(161, 161, 170, 0.4)',
    crosshairLabel: '#27272a',
    series: ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee', '#f87171', '#a1a1aa'],
  },
  light: {
    positive: '#059669',
    negative: '#dc2626',
    warning: '#d97706',
    accent: '#2563eb',
    neutral: '#71717a',
    subtle: '#71717a',
    fg: '#18181b',
    surface: '#ffffff',
    grid: 'rgba(0, 0, 0, 0.06)',
    border: 'rgba(0, 0, 0, 0.1)',
    zeroLine: 'rgba(0, 0, 0, 0.15)',
    crosshair: 'rgba(82, 82, 91, 0.45)',
    crosshairLabel: '#3f3f46',
    series: ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#71717a'],
  },
};

export function useChartPalette(): ChartPalette {
  return CHART_PALETTES[useTheme()];
}
