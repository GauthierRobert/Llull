/** SVG painter of a nodal result on a mesh skin: banded contours (blue = low, red = high), colour legend, extremes and set markers. */

import type { Vec3 } from '@core/model/vectors';
import type { ViewFrame } from '@core/geometry/viewProjection';
import { escapeXml } from '@lib/escapeXml';
import { significantNumber } from '@lib/compactNumber';
import { resultColor, triangleBands } from '@lib/isoBands';
import type { SkinTriangle } from './fieldSurface';

export interface PlotMarker {
  readonly label: string;
  readonly color: string;
  /** Points marked with dots (already deformed). */
  readonly points: readonly Vec3[];
  /** Optional arrow drawn at the centroid of `points`, pointing along this world direction (a load). */
  readonly arrow?: Vec3;
}

export interface PlotExtreme {
  readonly value: number;
  readonly at: Vec3;
}

export interface FieldPlotInput {
  readonly title: string;
  readonly subtitle: string;
  readonly frame: ViewFrame;
  readonly width: number;
  readonly height: number;
  readonly skin: readonly SkinTriangle[];
  /** Plotted (deformed) position of a node. */
  readonly position: (node: number) => Vec3 | undefined;
  readonly value: (node: number) => number | undefined;
  readonly levels: readonly number[];
  readonly unit: string;
  /** Faint silhouette of the undeformed skin, drawn under the plot (null: none). */
  readonly ghost: ((node: number) => Vec3 | undefined) | null;
  readonly showMesh: boolean;
  /** Magnification about `focus` (1 frames the whole part). */
  readonly zoom: number;
  /** Point kept at the centre of the drawing area when zoomed (null: the part centre). */
  readonly focus: Vec3 | null;
  readonly markers: readonly PlotMarker[];
  readonly min: PlotExtreme | null;
  readonly max: PlotExtreme | null;
}

const LEGEND_WIDTH = 150;
const HEADER = 46;
const FOOTER = 26;

const label = (value: number): string => significantNumber(value, 4);
const r1 = (value: number): number => Math.round(value * 10) / 10;

function shaded(hex: string, factor: number): string {
  const channel = (offset: number): number => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * factor);
  return `rgb(${channel(1)},${channel(3)},${channel(5)})`;
}

const normalOf = (a: Vec3, b: Vec3, c: Vec3): Vec3 => {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(n[0], n[1], n[2]);
  return length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 0];
};

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Placed {
  readonly points: readonly [Vec3, Vec3, Vec3];
  readonly values: readonly [number, number, number];
  readonly depth: number;
  readonly light: number;
}

/** Front-facing skin triangles with their values, far to near. */
function placedTriangles(input: FieldPlotInput): Placed[] {
  const placed: Placed[] = [];
  for (const triangle of input.skin) {
    const points = triangle.map(input.position);
    const values = triangle.map(input.value);
    const [a, b, c] = points;
    const [va, vb, vc] = values;
    if (a === undefined || b === undefined || c === undefined || va === undefined || vb === undefined || vc === undefined) continue;
    const facing = dot(normalOf(a, b, c), input.frame.toViewer);
    if (facing <= 0) continue;
    const depth = (dot(a, input.frame.toViewer) + dot(b, input.frame.toViewer) + dot(c, input.frame.toViewer)) / 3;
    placed.push({ points: [a, b, c], values: [va, vb, vc], depth, light: 0.62 + 0.38 * facing });
  }
  return placed.sort((p, q) => p.depth - q.depth);
}

/** Screen fit of the plotted points into the drawing area left of the legend. */
function fitter(input: FieldPlotInput, points: readonly Vec3[]): (p: Vec3) => readonly [number, number] {
  const sheet = points.map(input.frame.project);
  const xs = sheet.map((p) => p[0]);
  const ys = sheet.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [minOf(xs), maxOf(xs), minOf(ys), maxOf(ys)];
  const areaWidth = input.width - LEGEND_WIDTH - 24;
  const areaHeight = input.height - HEADER - FOOTER - 24;
  const fit = Math.min(areaWidth / Math.max(maxX - minX, 1e-12), areaHeight / Math.max(maxY - minY, 1e-12));
  const scale = fit * input.zoom;
  const [cx, cy] = input.focus === null ? [(minX + maxX) / 2, (minY + maxY) / 2] : input.frame.project(input.focus);
  const centreX = 12 + areaWidth / 2;
  const centreY = HEADER + 12 + areaHeight / 2;
  return (p) => {
    const [x, y] = input.frame.project(p);
    return [r1(centreX + (x - cx) * scale), r1(centreY - (y - cy) * scale)];
  };
}

/** Min / max of a large array without spreading it into one call (which overflows the stack above ~100k values). */
const minOf = (values: readonly number[]): number => values.reduce((best, value) => Math.min(best, value), Infinity);
const maxOf = (values: readonly number[]): number => values.reduce((best, value) => Math.max(best, value), -Infinity);

const pathOf = (points: readonly (readonly [number, number])[]): string => `M${points.map(([x, y]) => `${x} ${y}`).join('L')}Z`;

function legend(input: FieldPlotInput): string[] {
  const bands = input.levels.length - 1;
  const top = HEADER + 20;
  const barHeight = Math.max(80, input.height - top - FOOTER - 30);
  const step = barHeight / Math.max(1, bands);
  const x = input.width - LEGEND_WIDTH + 14;
  const out = [`<text x="${x}" y="${top - 8}" fill="#e8e8f0" font-size="12" font-weight="bold">${escapeXml(input.unit)}</text>`];
  for (let band = 0; band < bands; band += 1) {
    const y = r1(top + (bands - 1 - band) * step);
    out.push(`<rect x="${x}" y="${y}" width="22" height="${r1(step + 0.5)}" fill="${resultColor((band + 0.5) / bands)}"/>`);
  }
  input.levels.forEach((level, index) => {
    const y = r1(top + (bands - index) * step);
    out.push(`<text x="${x + 28}" y="${r1(y + 4)}" fill="#e8e8f0" font-size="11">${escapeXml(label(level))}</text>`);
  });
  return out;
}

/** A halo text label kept inside the plot area: it flips left of its anchor when it would run into the legend. */
function haloText(x: number, y: number, text: string, color: string, plotRight: number, bold: boolean): string {
  const anchorEnd = x + 7 * text.length > plotRight;
  return (
    `<text x="${r1(anchorEnd ? x - 16 : x)}" y="${r1(y)}" text-anchor="${anchorEnd ? 'end' : 'start'}" fill="${color}" stroke="#000" ` +
    `stroke-width="3" paint-order="stroke" font-size="12"${bold ? ' font-weight="bold"' : ''}>${escapeXml(text)}</text>`
  );
}

function extremeMarker(at: readonly [number, number], text: string, color: string, plotRight: number, below: boolean): string {
  const [x, y] = at;
  return (
    `<path d="M${x} ${y}l-6 -11h12z" fill="${color}" stroke="#000" stroke-width="1"/>` +
    haloText(x + 8, below ? y + 16 : y - 12, text, '#fff', plotRight, true)
  );
}

function markerSvg(
  marker: PlotMarker,
  screen: (p: Vec3) => readonly [number, number],
  scale: number,
  plotRight: number,
  inPlot: (at: readonly [number, number]) => boolean,
): string[] {
  const out: string[] = [];
  const stride = Math.max(1, Math.ceil(marker.points.length / 80));
  for (let index = 0; index < marker.points.length; index += stride) {
    const point = marker.points[index];
    if (point === undefined) continue;
    const at = screen(point);
    if (!inPlot(at)) continue;
    out.push(`<circle cx="${at[0]}" cy="${at[1]}" r="2.4" fill="${marker.color}" fill-opacity="0.75" stroke="#000" stroke-width="0.5"/>`);
  }
  if (marker.arrow !== undefined && marker.points.length > 0) {
    const count = marker.points.length;
    const centroid: Vec3 = [
      marker.points.reduce((sum, p) => sum + p[0], 0) / count,
      marker.points.reduce((sum, p) => sum + p[1], 0) / count,
      marker.points.reduce((sum, p) => sum + p[2], 0) / count,
    ];
    const [ax, ay, az] = marker.arrow;
    const length = Math.hypot(ax, ay, az);
    if (length > 0) {
      const tail: Vec3 = [centroid[0] - (ax / length) * scale, centroid[1] - (ay / length) * scale, centroid[2] - (az / length) * scale];
      const [x1, y1] = screen(tail);
      const [x2, y2] = screen(centroid);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = (turn: number): string => `${r1(x2 - 10 * Math.cos(angle + turn))} ${r1(y2 - 10 * Math.sin(angle + turn))}`;
      out.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${marker.color}" stroke-width="3"/>`,
        `<path d="M${x2} ${y2}L${head(0.45)}L${head(-0.45)}Z" fill="${marker.color}"/>`,
        haloText(x1 + 6, y1 - 6, marker.label, marker.color, plotRight, false),
      );
    }
  }
  return out;
}

/** The complete, self-contained SVG of the plot. @pure */
export function fieldPlotSvg(input: FieldPlotInput): { svg: string; trianglesDrawn: number } {
  const placed = placedTriangles(input);
  const ghostPoints =
    input.ghost === null
      ? []
      : input.skin.flatMap((triangle) => triangle.map((node) => input.ghost?.(node))).filter((p) => p !== undefined);
  const screen = fitter(input, [...placed.flatMap((p) => p.points), ...ghostPoints, ...input.markers.flatMap((m) => m.points)]);
  const sheet = placed.flatMap((p) => p.points.map(input.frame.project));
  const sheetXs = sheet.map((p) => p[0]);
  const size = maxOf(sheetXs) - minOf(sheetXs);
  const bands = input.levels.length - 1;
  const body: string[] = [];
  if (input.ghost !== null) {
    const ghostPaths = input.skin
      .map((triangle) => triangle.map((node) => input.ghost?.(node)))
      .filter((points): points is Vec3[] => points.every((p) => p !== undefined))
      .map((points) => pathOf(points.map(screen)));
    body.push(`<path d="${ghostPaths.join('')}" fill="#9a9ab8" fill-opacity="0.3" stroke="none"/>`);
  }
  const onScreen = (points: readonly (readonly [number, number])[]): boolean =>
    !(
      points.every(([x]) => x < 0) ||
      points.every(([x]) => x > input.width - LEGEND_WIDTH) ||
      points.every(([, y]) => y < HEADER) ||
      points.every(([, y]) => y > input.height - FOOTER)
    );
  for (const triangle of placed) {
    if (!onScreen(triangle.points.map(screen))) continue;
    for (const piece of triangleBands(triangle.points, triangle.values, input.levels)) {
      const color = shaded(resultColor((piece.band + 0.5) / bands), triangle.light);
      body.push(`<path d="${pathOf(piece.polygon.map(screen))}" fill="${color}" stroke="${color}" stroke-width="0.6"/>`);
    }
    if (input.showMesh)
      body.push(`<path d="${pathOf(triangle.points.map(screen))}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="0.4"/>`);
  }
  const plotRight = input.width - LEGEND_WIDTH;
  const inPlot = ([x, y]: readonly [number, number]): boolean => x >= 0 && x <= plotRight && y >= HEADER && y <= input.height - FOOTER;
  const markers = input.markers.flatMap((marker) => markerSvg(marker, screen, size * 0.15, plotRight, inPlot));
  const maxAt = input.max === null ? null : screen(input.max.at);
  const minAt = input.min === null ? null : screen(input.min.at);
  const crowded = maxAt !== null && minAt !== null && Math.hypot(maxAt[0] - minAt[0], maxAt[1] - minAt[1]) < 40;
  const extremes = [
    ...(input.max === null || maxAt === null || !inPlot(maxAt)
      ? []
      : [extremeMarker(maxAt, `MAX ${label(input.max.value)}`, '#ff3030', plotRight, false)]),
    ...(input.min === null || minAt === null || !inPlot(minAt)
      ? []
      : [extremeMarker(minAt, `MIN ${label(input.min.value)}`, '#3080ff', plotRight, crowded)]),
  ];
  const keyItems = input.markers.map(
    (marker, index) =>
      `<circle cx="${18 + index * 170}" cy="${input.height - 10}" r="4" fill="${marker.color}"/><text x="${26 + index * 170}" y="${input.height - 6}" fill="#e8e8f0" font-size="11">${escapeXml(marker.label.slice(0, 26))}</text>`,
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">`,
    `<rect width="${input.width}" height="${input.height}" fill="#1a1a2e"/>`,
    `<text x="12" y="20" fill="#ffffff" font-size="15" font-weight="bold">${escapeXml(input.title.slice(0, 120))}</text>`,
    `<text x="12" y="38" fill="#c8c8d8" font-size="12">${escapeXml(input.subtitle.slice(0, 160))}</text>`,
    ...body,
    ...markers,
    ...extremes,
    ...legend(input),
    ...keyItems,
    '</svg>',
  ].join('\n');
  return { svg, trianglesDrawn: placed.length };
}
