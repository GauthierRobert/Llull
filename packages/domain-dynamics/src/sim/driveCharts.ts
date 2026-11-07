/**
 * The two non-time-series charts of plot_simulation (PHY-23 DRV-M3): operating points on the torque-speed plane with the motor limits, and the energy ledger as
 * bars; plus the stacking of a chart under another into one SVG. Pure string building, deterministic.
 */

import { escapeXml } from '@lib/escapeXml';

const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b'] as const;
const MARGIN = { left: 78, right: 24, top: 30, bottom: 44 } as const;
const MAX_POINTS = 1500;

export interface XySeries {
  readonly label: string;
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  /** 'dots': operating points; 'line': a limit curve through the points in order. */
  readonly style: 'dots' | 'line';
}

export interface Chart {
  readonly svg: string;
  readonly height: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** high - low, or the unit width of an empty range (so a flat series still draws). */
const widthOf = (low: number, high: number): number => (high > low ? high - low : 1);

/** Ticks covering [low, high] at a 1/2/5 x 10^k step. */
function ticks(low: number, high: number): number[] {
  const span = high - low;
  if (!(span > 0)) return [low];
  const raw = span / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const ratio = raw / magnitude;
  const step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * magnitude;
  const first = Math.ceil(low / step - 1e-9);
  return Array.from({ length: Math.max(0, Math.floor(high / step + 1e-9) - first + 1) }, (_, k) => (first + k) * step);
}

const label = (value: number): string =>
  Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-3) ? value.toExponential(1) : String(round(value));

/** The `<svg>` inner markup of a chart, without the outer element (so charts can be stacked). */
const inner = (svg: string): string => svg.replace(/^<svg[^>]*>\n?/, '').replace(/\n?<\/svg>$/, '');

/** An XY chart: axes with ticks and a grid, dots for operating points, polylines for limit curves, a legend. */
export function xyChart(title: string, xLabel: string, yLabel: string, series: readonly XySeries[], width: number, height = 340): Chart {
  const [x0, x1, y0, y1] = [MARGIN.left, width - MARGIN.right, MARGIN.top, height - MARGIN.bottom];
  const xs = series.flatMap((s) => s.xs).filter(Number.isFinite);
  const ys = series.flatMap((s) => s.ys).filter(Number.isFinite);
  const [xLow, xHigh] = [Math.min(0, ...xs), Math.max(0, ...xs, 1e-12)];
  const [yLow, yHigh] = [Math.min(0, ...ys), Math.max(0, ...ys, 1e-12)];
  const sx = (x: number): number => x0 + ((x - xLow) / widthOf(xLow, xHigh)) * (x1 - x0);
  const sy = (y: number): number => y1 - ((y - yLow) / widthOf(yLow, yHigh)) * (y1 - y0);
  const parts: string[] = [`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#ffffff" stroke="#888888"/>`];
  for (const tick of ticks(yLow, yHigh))
    parts.push(
      `<line x1="${x0}" y1="${round(sy(tick))}" x2="${x1}" y2="${round(sy(tick))}" stroke="${tick === 0 ? '#555555' : '#e2e2e2'}"/>`,
      `<text x="${x0 - 6}" y="${round(sy(tick) + 4)}" text-anchor="end" font-size="11" ${FONT}>${label(tick)}</text>`,
    );
  for (const tick of ticks(xLow, xHigh))
    parts.push(
      `<line x1="${round(sx(tick))}" y1="${y0}" x2="${round(sx(tick))}" y2="${y1}" stroke="${tick === 0 ? '#555555' : '#eeeeee'}"/>`,
      `<text x="${round(sx(tick))}" y="${y1 + 16}" text-anchor="middle" font-size="11" ${FONT}>${label(tick)}</text>`,
    );
  series.forEach((s, k) => {
    const colour = PALETTE[k % PALETTE.length];
    const stride = Math.max(1, Math.ceil(s.xs.length / MAX_POINTS));
    const picked = s.xs
      .map((x, i) => [x, s.ys[i] ?? Number.NaN] as const)
      .filter(([x, y], i) => i % stride === 0 && Number.isFinite(x) && Number.isFinite(y));
    if (s.style === 'line')
      parts.push(
        `<polyline fill="none" stroke="${colour}" stroke-width="1.8" points="${picked.map(([x, y]) => `${round(sx(x))},${round(sy(y))}`).join(' ')}"/>`,
      );
    else
      for (const [x, y] of picked)
        parts.push(`<circle cx="${round(sx(x))}" cy="${round(sy(y))}" r="2" fill="${colour}" fill-opacity="0.55"/>`);
    parts.push(
      `<line x1="${x1 - 190}" y1="${y0 + 10 + k * 15}" x2="${x1 - 172}" y2="${y0 + 10 + k * 15}" stroke="${colour}" stroke-width="2.5"/>`,
      `<text x="${x1 - 166}" y="${y0 + 14 + k * 15}" font-size="11" ${FONT}>${escapeXml(s.label)}</text>`,
    );
  });
  parts.push(
    `<text x="${x0}" y="${y0 - 10}" font-size="13" font-weight="bold" ${FONT}>${escapeXml(title)}</text>`,
    `<text x="${(x0 + x1) / 2}" y="${height - 8}" text-anchor="middle" font-size="12" ${FONT}>${escapeXml(xLabel)}</text>`,
    `<text transform="translate(16 ${round((y0 + y1) / 2)}) rotate(-90)" text-anchor="middle" font-size="12" ${FONT}>${escapeXml(yLabel)}</text>`,
  );
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${parts.join('\n')}\n</svg>`,
    height,
  };
}

/** A horizontal bar chart of signed values (one bar per entry), the zero line in the middle of the data range. */
export function barChart(
  title: string,
  unit: string,
  bars: readonly { readonly label: string; readonly value: number }[],
  width: number,
): Chart {
  const rowHeight = 22;
  const height = MARGIN.top + bars.length * rowHeight + 28;
  const [labelWidth, x1] = [210, width - MARGIN.right - 70];
  const x0 = MARGIN.left + labelWidth - 78;
  const [low, high] = [Math.min(0, ...bars.map((bar) => bar.value)), Math.max(0, ...bars.map((bar) => bar.value), 1e-12)];
  const sx = (v: number): number => x0 + ((v - low) / widthOf(low, high)) * (x1 - x0);
  const parts: string[] = [
    `<text x="${MARGIN.left}" y="${MARGIN.top - 10}" font-size="13" font-weight="bold" ${FONT}>${escapeXml(title)} (${escapeXml(unit)})</text>`,
  ];
  bars.forEach((bar, k) => {
    const y = MARGIN.top + k * rowHeight;
    const [a, b] = [sx(Math.min(0, bar.value)), sx(Math.max(0, bar.value))];
    parts.push(
      `<text x="${x0 - 6}" y="${y + 14}" text-anchor="end" font-size="11" ${FONT}>${escapeXml(bar.label)}</text>`,
      `<rect x="${round(a)}" y="${y + 3}" width="${round(Math.max(1, b - a))}" height="${rowHeight - 8}" fill="${bar.value < 0 ? '#2ca02c' : '#1f77b4'}"/>`,
      `<text x="${round(b + 4)}" y="${y + 14}" font-size="11" ${FONT}>${label(Number(bar.value.toPrecision(4)))}</text>`,
    );
  });
  parts.push(
    `<line x1="${round(sx(0))}" y1="${MARGIN.top - 2}" x2="${round(sx(0))}" y2="${MARGIN.top + bars.length * rowHeight}" stroke="#555555"/>`,
  );
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${parts.join('\n')}\n</svg>`,
    height,
  };
}

/** Charts stacked top to bottom as one SVG of `width` (each chart keeps its own title). */
export function stackCharts(charts: readonly Chart[], width: number): Chart {
  const height = charts.reduce((sum, chart) => sum + chart.height, 0);
  let y = 0;
  const body = charts.map((chart) => {
    const group = `<g transform="translate(0 ${y})">\n${inner(chart.svg)}\n</g>`;
    y += chart.height;
    return group;
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#fafafa"/>`,
    ...body,
    '</svg>',
  ].join('\n');
  return { svg, height };
}
