/** Stacked time-series chart as SVG text: one panel per unit with axes, ticks, grid, legend and title (headless "look at the curve"). */

import { escapeXml } from './escapeXml';

export interface PlotSeries {
  readonly label: string;
  readonly values: readonly number[];
  /** Time of each value; absent = the shared `times` of the layout. Non-finite values are skipped, never drawn. */
  readonly times?: readonly number[];
}

export interface PlotPanel {
  /** Panel heading, e.g. "Joint speed". */
  readonly title: string;
  /** Unit of the y axis, e.g. "rpm". */
  readonly unit: string;
  readonly series: readonly PlotSeries[];
}

interface PlotLayout {
  readonly title: string;
  readonly width: number;
  readonly panelHeight: number;
  /** Shared time axis (seconds) of the series without their own `times`; also fixes the axis range. Absent = the range of the series times. */
  readonly times?: readonly number[];
  /** Keep 0 inside the value axis (default true: motion plots). Probe curves set false. */
  readonly includeZero?: boolean;
  /** Distance of the legend from the right edge (default 150). */
  readonly legendOffset?: number;
}

const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf'] as const;
const MARGIN = { left: 78, right: 24, top: 26, bottom: 44 } as const;
const TITLE_HEIGHT = 40;
const MAX_POINTS = 1500;
const TICKS = 5;
const FONT = 'font-family="Helvetica, Arial, sans-serif"';

const round = (value: number): number => Math.round(value * 100) / 100;

/** Tick positions covering [low, high] at a 1/2/5 x 10^k step. */
function niceTicks(low: number, high: number, count = TICKS): { ticks: number[]; step: number } {
  const span = high - low;
  if (!(span > 0)) return { ticks: [low], step: 1 };
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
  const first = Math.ceil(low / step - 1e-9);
  const last = Math.floor(high / step + 1e-9);
  return { ticks: Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => (first + k) * step), step };
}

function tickLabel(value: number, step: number): string {
  if (value === 0) return '0';
  const decimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  const text = Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4 ? value.toExponential(2) : value.toFixed(decimals);
  return text;
}

/** Evenly thinned copy of the index range 0..n-1 with at most MAX_POINTS entries (first and last kept). */
function indices(n: number): number[] {
  const stride = Math.max(1, Math.ceil(n / MAX_POINTS));
  const picked = Array.from({ length: Math.ceil(n / stride) }, (_, k) => k * stride);
  if (picked[picked.length - 1] !== n - 1 && n > 0) picked.push(n - 1);
  return picked;
}

function panelSvg(panel: PlotPanel, layout: PlotLayout, top: number, bottomAxis: boolean): string {
  const { width, panelHeight } = layout;
  const [x0, x1] = [MARGIN.left, width - MARGIN.right];
  const [y0, y1] = [top + MARGIN.top, top + panelHeight - (bottomAxis ? MARGIN.bottom : 12)];
  const all = panel.series.flatMap((s) => s.values).filter(Number.isFinite);
  const includeZero = layout.includeZero !== false;
  let [low, high] = includeZero ? [Math.min(0, ...all), Math.max(0, ...all)] : [Math.min(...all), Math.max(...all)];
  if (high - low < 1e-12) [low, high] = [low - 1, high + 1];
  const pad = (high - low) * 0.05;
  [low, high] = includeZero ? [low === 0 ? 0 : low - pad, high === 0 ? 0 : high + pad] : [low - pad, high + pad];
  const seen = layout.times ?? panel.series.flatMap((s) => (s.times ?? []).filter(Number.isFinite));
  const [tMin, tMax] = layout.times !== undefined ? [seen[0] ?? 0, seen[seen.length - 1] ?? 1] : [Math.min(...seen), Math.max(...seen)];
  const sx = (t: number): number => x0 + ((t - tMin) / (tMax - tMin || 1)) * (x1 - x0);
  const sy = (v: number): number => y1 - ((v - low) / (high - low || 1)) * (y1 - y0);
  const parts: string[] = [`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#ffffff" stroke="#888888"/>`];
  const yAxis = niceTicks(low, high);
  for (const tick of yAxis.ticks)
    parts.push(
      `<line x1="${x0}" y1="${round(sy(tick))}" x2="${x1}" y2="${round(sy(tick))}" stroke="${tick === 0 ? '#555555' : '#e2e2e2'}"/>`,
      `<text x="${x0 - 6}" y="${round(sy(tick) + 4)}" text-anchor="end" font-size="11" ${FONT}>${tickLabel(tick, yAxis.step)}</text>`,
    );
  const xAxis = niceTicks(tMin, tMax);
  for (const tick of xAxis.ticks) {
    parts.push(`<line x1="${round(sx(tick))}" y1="${y0}" x2="${round(sx(tick))}" y2="${y1}" stroke="#eeeeee"/>`);
    if (bottomAxis)
      parts.push(
        `<text x="${round(sx(tick))}" y="${y1 + 16}" text-anchor="middle" font-size="11" ${FONT}>${tickLabel(tick, xAxis.step)}</text>`,
      );
  }
  if (bottomAxis) parts.push(`<text x="${(x0 + x1) / 2}" y="${y1 + 34}" text-anchor="middle" font-size="12" ${FONT}>time (s)</text>`);
  panel.series.forEach((series, k) => {
    const times = series.times ?? layout.times ?? [];
    const points = indices(times.length)
      .filter((i) => Number.isFinite(series.values[i]) && Number.isFinite(times[i]))
      .map((i) => `${round(sx(times[i] ?? 0))},${round(sy(series.values[i] ?? 0))}`);
    if (points.length > 0)
      parts.push(`<polyline fill="none" stroke="${PALETTE[k % PALETTE.length]}" stroke-width="1.6" points="${points.join(' ')}"/>`);
  });
  parts.push(
    `<text x="${x0}" y="${y0 - 8}" font-size="13" font-weight="bold" ${FONT}>${escapeXml(panel.title)} (${escapeXml(panel.unit)})</text>`,
    `<text transform="translate(16 ${round((y0 + y1) / 2)}) rotate(-90)" text-anchor="middle" font-size="12" ${FONT}>${escapeXml(panel.unit)}</text>`,
  );
  panel.series.forEach((series, k) => {
    const [lx, ly] = [x1 - (layout.legendOffset ?? 150), y0 + 14 + k * 15];
    parts.push(
      `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 18}" y2="${ly - 4}" stroke="${PALETTE[k % PALETTE.length]}" stroke-width="2.5"/>`,
      `<text x="${lx + 24}" y="${ly}" font-size="11" ${FONT}>${escapeXml(series.label)}</text>`,
    );
  });
  return parts.join('\n');
}

/** The complete SVG document of `panels` stacked under one title, sharing the time axis of `layout.times`. */
export function timeSeriesSvg(panels: readonly PlotPanel[], layout: PlotLayout): { svg: string; height: number } {
  const height = TITLE_HEIGHT + panels.length * layout.panelHeight;
  const body = panels.map((panel, k) => panelSvg(panel, layout, TITLE_HEIGHT + k * layout.panelHeight, k === panels.length - 1));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${height}" viewBox="0 0 ${layout.width} ${height}">`,
    `<rect width="${layout.width}" height="${height}" fill="#fafafa"/>`,
    `<text x="${layout.width / 2}" y="24" text-anchor="middle" font-size="16" font-weight="bold" ${FONT}>${escapeXml(layout.title)}</text>`,
    ...body,
    '</svg>',
  ].join('\n');
  return { svg, height };
}
