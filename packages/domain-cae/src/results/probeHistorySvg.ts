/** Probe-history chart as SVG text: one panel per unit, shared time axis, polyline per probe, legend (headless "look at the curve"). */

import type { HistorySeries } from './probeHistory';

const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf'] as const;
const MARGIN = { left: 78, right: 24, top: 30, bottom: 40 } as const;
const TITLE_HEIGHT = 36;
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const TICKS = 5;

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const round = (value: number): number => Math.round(value * 100) / 100;
const label = (value: number): string => (value === 0 ? '0' : Number(value.toPrecision(4)).toString());

/** Series that can be drawn: at least two increments, all with a value. */
const plottable = (series: readonly HistorySeries[]): HistorySeries[] =>
  series.filter((entry) => entry.points.length >= 2 && entry.missing === 0);

function panelSvg(unit: string, series: readonly HistorySeries[], width: number, top: number, height: number, last: boolean): string[] {
  const [x0, x1] = [MARGIN.left, width - MARGIN.right];
  const [y0, y1] = [top + MARGIN.top, top + height - (last ? MARGIN.bottom : 12)];
  const times = series.flatMap((entry) => entry.points.map((point) => point.time));
  const values = series.flatMap((entry) => entry.points.map((point) => point.value));
  const [tMin, tMax] = [Math.min(...times), Math.max(...times)];
  let [low, high] = [Math.min(...values), Math.max(...values)];
  if (high - low < 1e-12) [low, high] = [low - 1, high + 1];
  const pad = (high - low) * 0.05;
  [low, high] = [low - pad, high + pad];
  const sx = (time: number): number => x0 + ((time - tMin) / (tMax - tMin || 1)) * (x1 - x0);
  const sy = (value: number): number => y1 - ((value - low) / (high - low)) * (y1 - y0);
  const parts = [`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#ffffff" stroke="#888888"/>`];
  for (let k = 0; k <= TICKS; k++) {
    const value = low + ((high - low) * k) / TICKS;
    const time = tMin + ((tMax - tMin) * k) / TICKS;
    parts.push(
      `<line x1="${x0}" y1="${round(sy(value))}" x2="${x1}" y2="${round(sy(value))}" stroke="#e2e2e2"/>`,
      `<text x="${x0 - 6}" y="${round(sy(value) + 4)}" text-anchor="end" font-size="11" ${FONT}>${label(value)}</text>`,
    );
    if (last) parts.push(`<text x="${round(sx(time))}" y="${y1 + 16}" text-anchor="middle" font-size="11" ${FONT}>${label(time)}</text>`);
  }
  if (last) parts.push(`<text x="${(x0 + x1) / 2}" y="${y1 + 32}" text-anchor="middle" font-size="12" ${FONT}>time (s)</text>`);
  series.forEach((entry, k) => {
    const points = entry.points.map((point) => `${round(sx(point.time))},${round(sy(point.value))}`).join(' ');
    const [lx, ly] = [x1 - 170, y0 + 14 + k * 15];
    parts.push(
      `<polyline fill="none" stroke="${PALETTE[k % PALETTE.length]}" stroke-width="1.6" points="${points}"/>`,
      `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 18}" y2="${ly - 4}" stroke="${PALETTE[k % PALETTE.length]}" stroke-width="2.5"/>`,
      `<text x="${lx + 24}" y="${ly}" font-size="11" ${FONT}>${escapeXml(`${entry.name} (${entry.quantity})`)}</text>`,
    );
  });
  parts.push(`<text x="${x0}" y="${y0 - 8}" font-size="13" font-weight="bold" ${FONT}>${escapeXml(unit)}</text>`);
  return parts;
}

/** SVG of the plottable series of `series`, one panel per unit; null when none is plottable. */
export function probeHistorySvg(
  series: readonly HistorySeries[],
  title: string,
  width: number,
  panelHeight: number,
): { svg: string; height: number } | null {
  const drawn = plottable(series);
  if (drawn.length === 0) return null;
  const units = [...new Set(drawn.map((entry) => entry.unit))];
  const height = TITLE_HEIGHT + units.length * panelHeight;
  const body = units.flatMap((unit, k) =>
    panelSvg(
      unit,
      drawn.filter((entry) => entry.unit === unit),
      width,
      TITLE_HEIGHT + k * panelHeight,
      panelHeight,
      k === units.length - 1,
    ),
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#fafafa"/>`,
    `<text x="${width / 2}" y="24" text-anchor="middle" font-size="16" font-weight="bold" ${FONT}>${escapeXml(title)}</text>`,
    ...body,
    '</svg>',
  ].join('\n');
  return { svg, height };
}
