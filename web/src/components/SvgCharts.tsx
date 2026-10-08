import { useEffect, useRef, useState, type ReactNode } from 'react';

import { finite, formatInteger, formatNumber, formatPercent, formatProbability, formatRatio } from '../lib/format';
import type { CalibrationBin, FoldReport, HistogramBin, ImportanceRow } from '../lib/types';
import { cx } from './ui';

// Small inline-SVG charts. They render at the container's real pixel width (so text never
// scales), take colors from the theme tokens via fill-/stroke- utilities, and show a tooltip
// for the hovered mark.

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

interface Hover {
  x: number;
  y: number;
  content: ReactNode;
}

function ChartFrame({
  height,
  children,
  hover,
  label,
}: {
  height: number;
  children: (width: number) => ReactNode;
  hover: Hover | null;
  label: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg role="img" aria-label={label} width={width} height={height} className="block overflow-visible">
          {children(width)}
        </svg>
      ) : null}
      {hover && width > 0 ? (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-line-strong bg-surface-2 px-2.5 py-1.5 text-xs tabular-nums text-fg shadow-lg"
          style={{
            left: Math.min(Math.max(hover.x, 70), width - 70),
            top: Math.max(0, hover.y - 8),
            transform: 'translate(-50%, -100%)',
          }}
        >
          {hover.content}
        </div>
      ) : null}
    </div>
  );
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function YAxis({ ticks, y, width, format }: { ticks: number[]; y: (v: number) => number; width: number; format: (v: number) => string }) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-line" strokeWidth={1} />
          <text x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-fg-subtle text-[11px]">
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

// ---- AUC per fold -----------------------------------------------------------------------------

export function FoldAucChart({ folds, height = 200 }: { folds: FoldReport[]; height?: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const points = folds.map((fold) => ({ fold, auc: finite(fold.auc) }));
  const values = points.map((p) => p.auc).filter((v): v is number => v !== null);
  const min = Math.min(0.45, ...values.map((v) => Math.floor(v * 50) / 50));
  const max = Math.max(0.6, ...values.map((v) => Math.ceil(v * 50) / 50));

  return (
    <ChartFrame height={height} hover={hover} label="AUC per walk-forward fold">
      {(width) => {
        const plotW = width - PAD.left - PAD.right;
        const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (height - PAD.top - PAD.bottom);
        const slot = plotW / Math.max(1, points.length);
        const barW = Math.max(2, Math.min(28, slot - 2));
        const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 44))));
        return (
          <g onMouseLeave={() => setHover(null)}>
            <YAxis ticks={niceTicks(min, max)} y={y} width={width} format={(v) => formatNumber(v, 2)} />
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(0.5)}
              y2={y(0.5)}
              className="stroke-fg-subtle"
              strokeDasharray="4 3"
              strokeWidth={1}
            />
            <text x={width - PAD.right} y={y(0.5) - 4} textAnchor="end" className="fill-fg-subtle text-[10px]">
              random 0.50
            </text>
            {points.map(({ fold, auc }, index) => {
              const cx0 = PAD.left + slot * index + slot / 2;
              const top = auc === null ? y(0.5) : y(Math.max(auc, 0.5));
              const bottom = auc === null ? y(0.5) : y(Math.min(auc, 0.5));
              const tone = auc === null ? 'fill-fg-subtle' : auc >= 0.5 ? 'fill-positive' : 'fill-negative';
              return (
                <g key={fold.index}>
                  <rect
                    x={cx0 - slot / 2}
                    y={PAD.top}
                    width={slot}
                    height={height - PAD.top - PAD.bottom}
                    fill="transparent"
                    onMouseEnter={() =>
                      setHover({
                        x: cx0,
                        y: top,
                        content: (
                          <>
                            <div className="font-medium">Fold {fold.index + 1}</div>
                            <div className="text-fg-muted">AUC {formatNumber(auc, 4)}</div>
                          </>
                        ),
                      })
                    }
                  />
                  <rect
                    x={cx0 - barW / 2}
                    y={top}
                    width={barW}
                    height={Math.max(1, bottom - top)}
                    rx={Math.min(3, barW / 2)}
                    className={cx(tone, 'pointer-events-none')}
                  />
                  {index % labelEvery === 0 ? (
                    <text x={cx0} y={height - 8} textAnchor="middle" className="fill-fg-subtle text-[11px]">
                      {fold.index + 1}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      }}
    </ChartFrame>
  );
}

// ---- Calibration ------------------------------------------------------------------------------

export function CalibrationChart({ bins, height = 240 }: { bins: CalibrationBin[]; height?: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const valid = bins.filter((bin) => finite(bin.mean_prob) !== null && finite(bin.hit_rate) !== null);
  const top = Math.min(1, Math.max(0.1, ...valid.flatMap((bin) => [bin.mean_prob, bin.hit_rate])) * 1.1);

  return (
    <ChartFrame height={height} hover={hover} label="Calibration: predicted probability versus observed hit rate">
      {(width) => {
        const plotW = width - PAD.left - PAD.right;
        const plotH = height - PAD.top - PAD.bottom;
        const x = (v: number) => PAD.left + (v / top) * plotW;
        const y = (v: number) => PAD.top + (1 - v / top) * plotH;
        const ticks = niceTicks(0, top);
        const path = valid.map((bin, i) => `${i === 0 ? 'M' : 'L'}${x(bin.mean_prob)},${y(bin.hit_rate)}`).join(' ');
        return (
          <g onMouseLeave={() => setHover(null)}>
            <YAxis ticks={ticks} y={y} width={width} format={(v) => formatRatio(v, 0)} />
            {ticks.map((tick) => (
              <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="fill-fg-subtle text-[11px]">
                {formatRatio(tick, 0)}
              </text>
            ))}
            <line x1={x(0)} y1={y(0)} x2={x(top)} y2={y(top)} className="stroke-fg-subtle" strokeDasharray="4 3" strokeWidth={1} />
            <path d={path} fill="none" className="stroke-accent-fg" strokeWidth={2} />
            {valid.map((bin, index) => (
              <g key={index}>
                <circle
                  cx={x(bin.mean_prob)}
                  cy={y(bin.hit_rate)}
                  r={4}
                  className="fill-accent-fg stroke-surface"
                  strokeWidth={2}
                />
                <circle
                  cx={x(bin.mean_prob)}
                  cy={y(bin.hit_rate)}
                  r={12}
                  fill="transparent"
                  onMouseEnter={() =>
                    setHover({
                      x: x(bin.mean_prob),
                      y: y(bin.hit_rate),
                      content: (
                        <>
                          <div>Predicted {formatRatio(bin.mean_prob, 1)}</div>
                          <div>Observed {formatRatio(bin.hit_rate, 1)}</div>
                          <div className="text-fg-muted">{formatInteger(bin.n)} minutes</div>
                        </>
                      ),
                    })
                  }
                />
              </g>
            ))}
          </g>
        );
      }}
    </ChartFrame>
  );
}

// ---- Probability histogram --------------------------------------------------------------------

export function ProbabilityHistogram({
  bins,
  threshold,
  height = 200,
}: {
  bins: HistogramBin[];
  threshold?: number | null;
  height?: number;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  // Trim empty tails so the populated range is readable; keep at least [0.2, 0.8].
  const populated = bins.map((bin, i) => (bin.count > 0 ? i : -1)).filter((i) => i >= 0);
  const firstIndex = populated.length ? populated[0] : 0;
  const lastIndex = populated.length ? populated[populated.length - 1] : bins.length - 1;
  const lo = Math.min(0.2, bins[firstIndex]?.from ?? 0);
  const hi = Math.max(0.8, bins[lastIndex]?.to ?? 1);
  const shown = bins.filter((bin) => bin.from >= lo - 1e-9 && bin.to <= hi + 1e-9);
  const maxCount = Math.max(1, ...shown.map((bin) => bin.count));
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);

  return (
    <ChartFrame height={height} hover={hover} label="Distribution of out-of-sample probabilities">
      {(width) => {
        const plotW = width - PAD.left - PAD.right;
        const plotH = height - PAD.top - PAD.bottom;
        const x = (v: number) => PAD.left + ((v - lo) / (hi - lo)) * plotW;
        const y = (v: number) => PAD.top + (1 - v / maxCount) * plotH;
        const xTicks = niceTicks(lo, hi, 5);
        return (
          <g onMouseLeave={() => setHover(null)}>
            <YAxis ticks={niceTicks(0, maxCount, 3)} y={y} width={width} format={(v) => formatCompactAxis(v)} />
            {xTicks.map((tick) => (
              <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="fill-fg-subtle text-[11px]">
                {formatNumber(tick, 1)}
              </text>
            ))}
            {shown.map((bin) => {
              const left = x(bin.from) + 1;
              const barW = Math.max(1, x(bin.to) - x(bin.from) - 2);
              const above = threshold !== null && threshold !== undefined && bin.from >= threshold - 1e-9;
              return (
                <g key={bin.from}>
                  <rect
                    x={left}
                    y={y(bin.count)}
                    width={barW}
                    height={Math.max(0, y(0) - y(bin.count))}
                    rx={Math.min(2, barW / 2)}
                    className={above ? 'fill-accent-fg' : 'fill-fg-subtle'}
                    opacity={above ? 0.95 : 0.55}
                  />
                  <rect
                    x={left - 1}
                    y={PAD.top}
                    width={barW + 2}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() =>
                      setHover({
                        x: left + barW / 2,
                        y: y(bin.count),
                        content: (
                          <>
                            <div>
                              p {formatNumber(bin.from, 3)}–{formatNumber(bin.to, 3)}
                            </div>
                            <div className="text-fg-muted">
                              {formatInteger(bin.count)} minutes ({formatRatio(total ? bin.count / total : null, 2)})
                            </div>
                          </>
                        ),
                      })
                    }
                  />
                </g>
              );
            })}
            {threshold !== null && threshold !== undefined && threshold >= lo && threshold <= hi ? (
              <g>
                <line x1={x(threshold)} x2={x(threshold)} y1={PAD.top} y2={y(0)} className="stroke-warning" strokeWidth={1.5} />
                <text x={x(threshold) + 4} y={PAD.top + 10} className="fill-warning text-[11px]">
                  {formatProbability(threshold, 2)}
                </text>
              </g>
            ) : null}
          </g>
        );
      }}
    </ChartFrame>
  );
}

function formatCompactAxis(value: number): string {
  if (Math.abs(value) >= 1e6) return `${formatNumber(value / 1e6, 1)}M`;
  if (Math.abs(value) >= 1e3) return `${formatNumber(value / 1e3, 0)}k`;
  return formatNumber(value, 0);
}

// ---- Random-entry baseline distribution -------------------------------------------------------

export function RandomBaselineStrip({
  returns,
  modelReturn,
  height = 84,
}: {
  returns: number[];
  modelReturn: number | null;
  height?: number;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const values = returns.filter((v) => finite(v) !== null);
  const all = modelReturn === null ? values : [...values, modelReturn];
  const rawMin = Math.min(0, ...all);
  const rawMax = Math.max(0, ...all);
  const pad = (rawMax - rawMin || 1) * 0.06;
  const min = rawMin - pad;
  const max = rawMax + pad;

  return (
    <ChartFrame height={height} hover={hover} label="Random-entry run returns compared with the model">
      {(width) => {
        const left = 12;
        const right = width - 12;
        const x = (v: number) => left + ((v - min) / (max - min)) * (right - left);
        const mid = 34;
        return (
          <g onMouseLeave={() => setHover(null)}>
            <line x1={left} x2={right} y1={mid} y2={mid} className="stroke-line-strong" strokeWidth={1} />
            <line x1={x(0)} x2={x(0)} y1={mid - 14} y2={mid + 14} className="stroke-fg-subtle" strokeWidth={1} strokeDasharray="3 3" />
            <text x={x(0)} y={mid + 28} textAnchor="middle" className="fill-fg-subtle text-[11px]">
              0%
            </text>
            {values.map((value, index) => (
              <circle
                key={index}
                cx={x(value)}
                cy={mid + ((index % 5) - 2) * 3}
                r={4}
                className="fill-fg-subtle stroke-surface"
                strokeWidth={1.5}
                opacity={0.8}
                onMouseEnter={() =>
                  setHover({ x: x(value), y: mid - 6, content: <>Random run {index + 1}: {formatPercent(value, 2, { sign: true })}</> })
                }
              />
            ))}
            {modelReturn !== null ? (
              <g>
                <line x1={x(modelReturn)} x2={x(modelReturn)} y1={mid - 20} y2={mid + 14} className="stroke-accent-fg" strokeWidth={2.5} />
                <text
                  x={x(modelReturn)}
                  y={mid - 24}
                  textAnchor={x(modelReturn) > width - 60 ? 'end' : x(modelReturn) < 60 ? 'start' : 'middle'}
                  className="fill-fg text-[11px] font-medium"
                >
                  Model {formatPercent(modelReturn, 1, { sign: true })}
                </text>
              </g>
            ) : null}
          </g>
        );
      }}
    </ChartFrame>
  );
}

// ---- Feature importance (HTML bars) -----------------------------------------------------------

export function ImportanceBars({ rows, limit = 30 }: { rows: ImportanceRow[]; limit?: number }) {
  const top = rows.slice(0, limit);
  const max = Math.max(1e-12, ...top.map((row) => finite(row.importance) ?? 0));

  return (
    <ol className="space-y-1">
      {top.map((row, index) => {
        const value = finite(row.importance) ?? 0;
        return (
          <li key={row.feature} className="grid grid-cols-[minmax(0,11rem)_1fr_3.5rem] items-center gap-2 text-xs sm:grid-cols-[minmax(0,15rem)_1fr_4rem]">
            <span className="truncate font-mono text-fg-muted" title={row.feature}>
              <span className="mr-1.5 text-fg-subtle">{index + 1}.</span>
              {row.feature}
            </span>
            <span className="h-2.5 overflow-hidden rounded-sm bg-surface-3">
              <span className="block h-full rounded-sm bg-accent-fg/80" style={{ width: `${(value / max) * 100}%` }} />
            </span>
            <span className="text-right tabular-nums text-fg">{formatRatio(value, 1)}</span>
          </li>
        );
      })}
    </ol>
  );
}
