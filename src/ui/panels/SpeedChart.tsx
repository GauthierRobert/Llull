// Compact SVG line chart of joint speeds (rpm) over simulated time, with a playback cursor. Up to four series (the largest peaks).

import React from 'react';

const WIDTH = 260;
const HEIGHT = 110;
const PAD = { left: 40, right: 8, top: 8, bottom: 18 };
const MAX_SERIES = 4;
/** Categorical palette tokens (defined in tokens.css), in series order. */
const SERIES_CLASSES = ['speed-chart__line--1', 'speed-chart__line--2', 'speed-chart__line--3', 'speed-chart__line--4'];

interface SpeedChartProps {
  readonly times: readonly number[];
  /** Series id → rpm per sample. */
  readonly series: Readonly<Record<string, readonly number[]>>;
  /** Playback time (s). */
  readonly cursor: number;
  /** Series shown first (driven / loaded joints), before the rest by peak speed. */
  readonly priority?: readonly string[];
}

const peak = (values: readonly number[]): number => values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

/** Every series reduced to at most ~WIDTH points (min/max kept per bucket is unnecessary for smooth speed curves). */
function path(times: readonly number[], values: readonly number[], x: (t: number) => number, y: (v: number) => number): string {
  const stride = Math.max(1, Math.floor(times.length / WIDTH));
  const points: string[] = [];
  for (let i = 0; i < times.length; i += stride) points.push(`${x(times[i] ?? 0).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`);
  const lastIndex = times.length - 1;
  points.push(`${x(times[lastIndex] ?? 0).toFixed(1)},${y(values[lastIndex] ?? 0).toFixed(1)}`);
  return `M${points.join('L')}`;
}

export function SpeedChart({ times, series, cursor, priority = [] }: SpeedChartProps): React.ReactElement | null {
  const rank = (id: string): number => (priority.includes(id) ? 0 : 1);
  const shown = Object.entries(series)
    .sort(([idA, a], [idB, b]) => rank(idA) - rank(idB) || peak(b) - peak(a))
    .slice(0, MAX_SERIES);
  const end = times[times.length - 1] ?? 0;
  if (shown.length === 0 || end <= 0) return null;
  const all = shown.flatMap(([, values]) => values);
  const low = Math.min(0, ...all);
  const high = Math.max(1, ...all);
  const x = (t: number): number => PAD.left + ((WIDTH - PAD.left - PAD.right) * t) / end;
  const y = (v: number): number => HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * (v - low)) / (high - low);
  const tick = (v: number): string => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));
  return (
    <figure className="speed-chart" data-testid="physics-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Joint speed in rpm over simulated time">
        <line className="speed-chart__axis" x1={PAD.left} y1={y(0)} x2={WIDTH - PAD.right} y2={y(0)} />
        <line className="speed-chart__axis" x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={HEIGHT - PAD.bottom} />
        <text className="speed-chart__tick" x={PAD.left - 4} y={y(high) + 4} textAnchor="end">
          {tick(high)}
        </text>
        <text className="speed-chart__tick" x={PAD.left - 4} y={y(low) + 4} textAnchor="end">
          {tick(low)}
        </text>
        <text className="speed-chart__tick" x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end">
          {end.toFixed(1)} s
        </text>
        {shown.map(([id, values], index) => (
          <path key={id} className={`speed-chart__line ${SERIES_CLASSES[index] ?? ''}`} d={path(times, values, x, y)} />
        ))}
        <line className="speed-chart__cursor" x1={x(cursor)} y1={PAD.top} x2={x(cursor)} y2={HEIGHT - PAD.bottom} />
      </svg>
      <figcaption className="speed-chart__legend">
        {shown.map(([id], index) => (
          <span key={id} className="speed-chart__key">
            <span className={`speed-chart__swatch ${SERIES_CLASSES[index] ?? ''}`} aria-hidden="true" />
            {id} (rpm)
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
