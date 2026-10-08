import type { ReactNode } from 'react';

import { cx, inputClassName } from './ui';

// Text-backed numeric input with label, hint, unit suffix and an error state.
export function NumberField({
  label,
  value,
  onChange,
  hint,
  error,
  warning,
  suffix,
  step = 'any',
  min,
  max,
  className,
  id,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  warning?: boolean;
  suffix?: string;
  step?: number | 'any';
  min?: number;
  max?: number;
  className?: string;
  id?: string;
}) {
  return (
    <label className={cx('block min-w-0', className)}>
      <span className="mb-1.5 block text-sm font-medium text-fg-muted">{label}</span>
      <span className="relative block">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={value}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
          onWheel={(event) => event.currentTarget.blur()}
          className={cx(
            inputClassName,
            suffix && 'pr-14',
            error && 'border-negative/70 focus:border-negative focus:ring-negative/25',
            !error && warning && 'border-warning/60',
          )}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-fg-subtle">{suffix}</span>
        ) : null}
      </span>
      {error ? (
        <span className="mt-1 block text-xs text-negative">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-fg-subtle">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  type = 'text',
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  placeholder?: string;
  type?: 'text' | 'date';
  className?: string;
}) {
  return (
    <label className={cx('block min-w-0', className)}>
      <span className="mb-1.5 block text-sm font-medium text-fg-muted">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
        className={cx(inputClassName, error && 'border-negative/70 focus:border-negative focus:ring-negative/25')}
      />
      {error ? (
        <span className="mt-1 block text-xs text-negative">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-fg-subtle">{hint}</span>
      ) : null}
    </label>
  );
}
