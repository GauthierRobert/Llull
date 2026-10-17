/** Plot of a nodal result: z-buffered banded contours (blue = low, red = high) as an embedded image, vector legend, extremes and set markers. */

import type { Vec3 } from '@core/model/vectors';
import type { ViewFrame } from '@core/geometry/viewProjection';
import { escapeXml } from '@lib/escapeXml';
import { significantNumber } from '@lib/compactNumber';
import { resultColor } from '@lib/isoBands';
import type { FieldFace } from './fieldFaces';
import { rasterField } from './fieldRaster';

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
  /** Faces to draw (skin of the plotted parts, plus the section faces of a cut). */
  readonly faces: readonly FieldFace[];
  readonly levels: readonly number[];
  readonly unit: string;
  /** Faint silhouette of the undeformed shape, drawn under the plot. */
  readonly ghost: boolean;
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

interface Fit {
  /** Logical pixel of a plotted point (unrounded). */
  readonly screen: (p: Vec3) => readonly [number, number];
  readonly pixelsPerUnit: number;
}

/** Screen fit of the plotted points into the drawing area left of the legend. */
function fitter(input: FieldPlotInput, points: readonly Vec3[]): Fit {
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
  return {
    pixelsPerUnit: scale,
    screen: (p) => {
      const [x, y] = input.frame.project(p);
      return [centreX + (x - cx) * scale, centreY - (y - cy) * scale];
    },
  };
}

/** Min / max of a large array without spreading it into one call (which overflows the stack above ~100k values). */
const minOf = (values: readonly number[]): number => values.reduce((best, value) => Math.min(best, value), Infinity);
const maxOf = (values: readonly number[]): number => values.reduce((best, value) => Math.max(best, value), -Infinity);

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
  shown: (point: Vec3) => boolean,
): string[] {
  const out: string[] = [];
  const stride = Math.max(1, Math.ceil(marker.points.length / 80));
  const visible = marker.points.filter(shown);
  for (let index = 0; index < visible.length; index += stride) {
    const point = visible[index];
    if (point === undefined) continue;
    const [x, y] = screen(point);
    out.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="2.4" fill="${marker.color}" fill-opacity="0.75" stroke="#000" stroke-width="0.5"/>`);
  }
  if (marker.arrow !== undefined && visible.length > 0) {
    const count = visible.length;
    const centroid: Vec3 = [
      visible.reduce((sum, p) => sum + p[0], 0) / count,
      visible.reduce((sum, p) => sum + p[1], 0) / count,
      visible.reduce((sum, p) => sum + p[2], 0) / count,
    ];
    const [ax, ay, az] = marker.arrow;
    const length = Math.hypot(ax, ay, az);
    if (length > 0) {
      const tail: Vec3 = [centroid[0] - (ax / length) * scale, centroid[1] - (ay / length) * scale, centroid[2] - (az / length) * scale];
      const [x1, y1] = screen(tail).map(r1) as [number, number];
      const [x2, y2] = screen(centroid).map(r1) as [number, number];
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

/** The complete, self-contained SVG of the plot: vector text around one embedded raster image. @pure */
export function fieldPlotSvg(input: FieldPlotInput): { svg: string; facesDrawn: number } {
  const plotRight = input.width - LEGEND_WIDTH;
  const area = { left: 0, top: HEADER, right: plotRight, bottom: input.height - FOOTER };
  const fitPoints = [
    ...input.faces.flatMap((face) => face.corners.map((corner) => corner.p)),
    ...(input.ghost ? input.faces.flatMap((face) => face.corners.map((corner) => corner.u)) : []),
    ...input.markers.flatMap((marker) => marker.points),
  ];
  const { screen: exact, pixelsPerUnit } = fitter(input, fitPoints);
  const screen = (p: Vec3): readonly [number, number] => {
    const [x, y] = exact(p);
    return [r1(x), r1(y)];
  };
  const sheetXs = fitPoints.map((p) => input.frame.project(p)[0]);
  const size = maxOf(sheetXs) - minOf(sheetXs);
  const raster = rasterField({
    faces: input.faces,
    ghost: input.ghost,
    toViewer: input.frame.toViewer,
    screen: exact,
    pixelsPerUnit,
    width: input.width,
    height: input.height,
    area,
    levels: input.levels,
    showMesh: input.showMesh,
    size,
  });
  const inPlot = ([x, y]: readonly [number, number]): boolean => x >= 0 && x <= plotRight && y >= HEADER && y <= input.height - FOOTER;
  const shown = (point: Vec3): boolean => inPlot(exact(point)) && raster.visible(point);
  const markers = input.markers.flatMap((marker) => markerSvg(marker, exact, size * 0.15, plotRight, shown));
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
    raster.image,
    ...markers,
    ...extremes,
    ...legend(input),
    ...keyItems,
    '</svg>',
  ].join('\n');
  return { svg, facesDrawn: raster.facesDrawn };
}
