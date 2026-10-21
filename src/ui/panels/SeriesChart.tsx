// Compact SVG line chart of named series over a shared x axis (time or crank angle) with a cursor. Click/drag seeks (onSeek).
// Okabe-Ito category colours come from CSS tokens (--cat-N); each series also gets a distinct dash so colour is never the only cue.

import React, { useRef } from 'react';
import { ChartAxes } from './ChartAxes';
import { decimatedIndices, formatTick, interpolate, pickSeries } from './seriesMath';

const WIDTH = 260;
const HEIGHT = 110;
const PAD = { left: 40, right: 8, top: 8, bottom: 18 };
const DEFAULT_MAX_SERIES = 4;
const DASHES = ['', '5 2', '1.5 2', '6 2 1.5 2'] as const;

interface ChartSeries {
  readonly id: string;
  readonly values: readonly number[];
  /** Legend text; defaults to the id. */
  readonly label?: string;
}

interface SeriesChartProps {
  /** x per sample, ascending (seconds or crank degrees). */
  readonly xs: readonly number[];
  readonly series: readonly ChartSeries[];
  /** Unit of the y values, printed in the legend ("rpm", "N·m"). */
  readonly unit: string;
  /** Axis caption: "s" or "° crank". */
  readonly xUnit?: string;
  /** Cursor position in x units. */
  readonly cursor: number;
  readonly onSeek?: (x: number) => void;
  /** Ids shown first, before the rest by peak. */
  readonly priority?: readonly string[];
  readonly maxSeries?: number;
  readonly title: string;
  readonly testId?: string;
  /** Labelled vertical marks on the x axis (e.g. TDC firing of cylinder 1 on the crank axis). */
  readonly marks?: readonly { readonly x: number; readonly label: string }[];
}

function linePath(xs: readonly number[], values: readonly number[], x: (v: number) => number, y: (v: number) => number): string {
  const points = decimatedIndices(xs.length, WIDTH).map((i) => `${x(xs[i] ?? 0).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`);
  return `M${points.join('L')}`;
}

export function SeriesChart({
  xs,
  series,
  unit,
  xUnit = 's',
  cursor,
  onSeek,
  priority = [],
  maxSeries = DEFAULT_MAX_SERIES,
  title,
  testId = 'series-chart',
  marks = [],
}: SeriesChartProps): React.ReactElement | null {
  const svgRef = useRef<SVGSVGElement>(null);
  const shown = pickSeries(series, priority, maxSeries);
  const start = xs[0] ?? 0;
  const end = xs[xs.length - 1] ?? 0;
  if (shown.length === 0 || end <= start) return null;
  const all = shown.flatMap((s) => s.values);
  const low = Math.min(0, ...all);
  const high = Math.max(1, ...all);
  const x = (v: number): number => PAD.left + ((WIDTH - PAD.left - PAD.right) * (v - start)) / (end - start);
  const y = (v: number): number => HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * (v - low)) / (high - low);
  const cursorX = x(Math.max(start, Math.min(end, cursor)));
  const seekFrom = (event: React.PointerEvent<SVGSVGElement>): void => {
    const box = svgRef.current?.getBoundingClientRect();
    if (onSeek === undefined || box === undefined || box.width === 0) return;
    const unitX = ((event.clientX - box.left) / box.width) * WIDTH;
    const fraction = (unitX - PAD.left) / (WIDTH - PAD.left - PAD.right);
    onSeek(start + Math.max(0, Math.min(1, fraction)) * (end - start));
  };
  const underCursor = shown.map((s) => `${s.label ?? s.id} ${formatTick(interpolate(xs, s.values, cursor))} ${unit}`).join(', ');
  return (
    <figure className="series-chart" data-testid={testId}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}: ${underCursor} at ${formatTick(cursor)} ${xUnit}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekFrom(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFrom(e);
        }}
        data-testid={`${testId}-plot`}
      >
        <ChartAxes
          frame={{ width: WIDTH, height: HEIGHT, pad: PAD }}
          baselineY={y(0)}
          yHigh={y(high)}
          yLow={y(low)}
          highLabel={formatTick(high)}
          lowLabel={formatTick(low)}
          endLabel={`${formatTick(end)} ${xUnit}`}
        />
        {shown.map((s, index) => (
          <path
            key={s.id}
            className={`series-chart__line series-chart__line--${(index % 8) + 1}`}
            strokeDasharray={DASHES[index % DASHES.length]}
            d={linePath(xs, s.values, x, y)}
          />
        ))}
        {marks
          .filter((mark) => mark.x >= start && mark.x <= end)
          .map((mark) => (
            <g key={`${mark.label}-${mark.x}`} className="series-chart__mark" data-testid={`${testId}-mark`}>
              <line x1={x(mark.x)} y1={PAD.top} x2={x(mark.x)} y2={HEIGHT - PAD.bottom} strokeDasharray="2 2" />
              <text className="series-chart__tick" x={x(mark.x) + 2} y={PAD.top + 8}>
                {mark.label}
              </text>
            </g>
          ))}
        <line
          className="series-chart__cursor"
          x1={cursorX}
          y1={PAD.top}
          x2={cursorX}
          y2={HEIGHT - PAD.bottom}
          data-testid={`${testId}-cursor`}
        />
      </svg>
      <figcaption className="series-chart__legend">
        {shown.map((s, index) => (
          <span key={s.id} className="series-chart__key">
            <svg className={`series-chart__swatch series-chart__line--${(index % 8) + 1}`} width="14" height="4" aria-hidden="true">
              <line x1="0" y1="2" x2="14" y2="2" strokeDasharray={DASHES[index % DASHES.length]} />
            </svg>
            {s.label ?? s.id} ({unit})
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
