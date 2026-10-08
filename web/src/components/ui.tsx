import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';

// Shared visual primitives. Tokens live in index.css (@theme).

export type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning';

export function cx(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ');
}

export function Card({
  children,
  className,
  as: Element = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section';
}) {
  return <Element className={cx('rounded-xl border border-line bg-surface', className)}>{children}</Element>;
}

// Nested block inside a Card (e.g. a stat tile or list group).
export function Inset({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-line bg-surface-2', className)}>{children}</div>;
}

export function SectionTitle({
  icon: Icon,
  title,
  description,
  aside,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight text-fg">
          {Icon ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" strokeWidth={2} /> : null}
          {title}
        </h3>
        {description ? <p className="mt-0.5 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {aside ? <div className="flex flex-wrap items-center gap-2">{aside}</div> : null}
    </div>
  );
}

export function Collapsible({
  icon: Icon,
  title,
  description,
  isOpen,
  onToggle,
  aside,
  children,
  bodyClassName = 'px-4 pb-4 sm:px-5 sm:pb-5',
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  aside?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <Card as="section">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          className="group flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
        >
          <ChevronRight
            aria-hidden="true"
            strokeWidth={2}
            className={cx(
              'h-4 w-4 shrink-0 text-fg-subtle transition-transform group-hover:text-fg',
              isOpen && 'rotate-90',
            )}
          />
          {Icon ? <Icon aria-hidden="true" strokeWidth={2} className="h-[18px] w-[18px] shrink-0 text-fg-muted" /> : null}
          <span className="min-w-0">
            <span className="block text-base font-semibold tracking-tight text-fg">{title}</span>
            {description ? <span className="block text-sm text-fg-muted">{description}</span> : null}
          </span>
        </button>
        {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
      </div>
      {isOpen ? <div className={bodyClassName}>{children}</div> : null}
    </Card>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg',
  accent: 'text-accent-fg',
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
};

export function toneText(tone: Tone) {
  return TONE_TEXT[tone];
}

export function toneForValue(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) < 0.005) {
    return 'neutral';
  }

  return value > 0 ? 'positive' : 'negative';
}

export function Stat({
  label,
  value,
  detail,
  tone = 'neutral',
  size = 'md',
  loading = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  className?: string;
}) {
  const valueSize = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';

  return (
    <div className={cx('min-w-0', className)}>
      <p className="truncate text-sm text-fg-muted">{label}</p>
      {loading ? (
        <span aria-hidden="true" className="mt-1.5 block h-7 w-28 animate-pulse rounded-md bg-surface-3" />
      ) : (
        <p className={cx('mt-0.5 truncate font-semibold tracking-tight tabular-nums', valueSize, TONE_TEXT[tone])}>
          {value}
        </p>
      )}
      {detail ? <div className="mt-0.5 text-sm text-fg-subtle">{detail}</div> : null}
    </div>
  );
}

// Label / value row for dense key-value lists.
export function KeyValue({
  label,
  value,
  tone = 'neutral',
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className={cx('text-right font-medium tabular-nums', TONE_TEXT[tone])}>{value}</span>
    </div>
  );
}

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-muted',
  accent: 'bg-accent/15 text-accent-fg',
  positive: 'bg-positive/12 text-positive',
  negative: 'bg-negative/12 text-negative',
  warning: 'bg-warning/12 text-warning',
};

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-white hover:bg-accent/90',
  secondary: 'border-line-strong bg-surface-3 text-fg hover:bg-fg/[0.08]',
  ghost: 'border-transparent bg-transparent text-fg-muted hover:bg-surface-3 hover:text-fg',
  danger: 'border-negative/25 bg-negative/10 text-negative hover:bg-negative/15',
  warning: 'border-warning/25 bg-warning/10 text-warning hover:bg-warning/15',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  className,
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
}) {
  return (
    <button
      type={type}
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-9 px-3 text-sm sm:h-8' : 'h-11 px-4 text-sm sm:h-9',
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {Icon ? <Icon aria-hidden="true" strokeWidth={2} className="h-4 w-4 shrink-0" /> : null}
      {children}
    </button>
  );
}

// Selectable option tile (radio-like choice cards).
export function ChoiceCard({
  selected,
  title,
  detail,
  onSelect,
  disabled,
}: {
  selected: boolean;
  title: ReactNode;
  detail?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cx(
        'rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-accent/60 bg-accent/10 ring-1 ring-accent/40'
          : 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3',
      )}
    >
      <span className="block text-sm font-semibold text-fg">{title}</span>
      {detail ? <span className="mt-0.5 block text-sm text-fg-muted">{detail}</span> : null}
    </button>
  );
}

export const inputClassName =
  'h-10 w-full min-w-0 rounded-lg border border-line-strong bg-surface-2 px-3 text-sm text-fg tabular-nums outline-none transition placeholder:text-fg-subtle focus:border-accent/70 focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block min-w-0', className)}>
      <span className="mb-1.5 block text-sm font-medium text-fg-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-fg-subtle">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint ? <span className="mt-0.5 block text-sm text-fg-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Notice({
  tone = 'neutral',
  icon: Icon,
  children,
  className,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const toneClass: Record<Tone, string> = {
    neutral: 'border-line bg-surface text-fg-muted',
    accent: 'border-accent/25 bg-accent/[0.07] text-fg',
    positive: 'border-positive/20 bg-positive/[0.06] text-fg',
    negative: 'border-negative/25 bg-negative/[0.07] text-fg',
    warning: 'border-warning/25 bg-warning/[0.07] text-fg',
  };

  return (
    <div className={cx('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm', toneClass[tone], className)}>
      {Icon ? <Icon aria-hidden="true" strokeWidth={2} className={cx('mt-0.5 h-4 w-4 shrink-0', TONE_TEXT[tone])} /> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const TABLE_HEAD_CELL = 'px-3 py-2 text-left text-sm font-medium text-fg-muted whitespace-nowrap';
export const TABLE_CELL = 'px-3 py-2 border-t border-line tabular-nums text-fg';

export function ProgressBar({ value, tone = 'accent', className }: { value: number | null | undefined; tone?: Tone; className?: string }) {
  const fraction = typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const fill: Record<Tone, string> = {
    neutral: 'bg-fg-subtle',
    accent: 'bg-accent',
    positive: 'bg-positive',
    negative: 'bg-negative',
    warning: 'bg-warning',
  };

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div className={cx('h-full rounded-full transition-[width] duration-500', fill[tone])} style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('block animate-pulse rounded-md bg-surface-3', className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center', className)}>
      {Icon ? <Icon aria-hidden="true" strokeWidth={2} className="h-5 w-5 text-fg-subtle" /> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children ? <div className="max-w-md text-sm text-fg-muted">{children}</div> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral',
  running: 'accent',
  done: 'positive',
  failed: 'negative',
  cancelled: 'warning',
};

export function StatusBadge({ status, progress }: { status: string; progress?: number | null }) {
  const showProgress = status === 'running' && typeof progress === 'number' && Number.isFinite(progress);
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
      {status === 'running' ? <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {status}
      {showProgress ? ` ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` : null}
    </Badge>
  );
}
