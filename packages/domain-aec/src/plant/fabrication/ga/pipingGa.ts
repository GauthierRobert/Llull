/**
 * Orthographic piping general arrangement (plant 05 ISO M5, §5.11, TR-ISO-13): the centrelines of pipe lines (any source) drawn TO SCALE on a plan (top view) or in a
 * section / elevation (the side the viewer stands on, as `export_elevation_sheet`), with the line label `<line>-DN<dn>-<spec>` along the longest run, the centreline
 * elevation `CL EL` and the bottom of pipe `BOP EL = CL - OD / 2` of each horizontal level, and flow arrows on runs over 1000 mm. A line of DN at or above
 * `doubleLineFromDn` is drawn double line (outside diameter), a smaller one single line. Every label is listed with its 3D value. Pure; world millimetres.
 */

import { sheetDrawingArea } from '@core/geometry/sheetLayout';
import { PAPER_MM, type PaperSize } from '@core/model/sheet';
import type { Vec2, Vec3 } from '@core/model/vectors';
import { distance3 } from '@lib/vec3';
import { outsideDiameterMm } from '../../../industrial/piping/pipeSizes';
import { isoIssue } from '../codes';
import { signed } from '../iso/isoDimensions';
import type { IsoGraph, IsoRun } from '../iso/isoGraph';
import type { IsoPrimitive } from '../iso/isoRender';
import { rect, text, titleBlock } from '../iso/isoSheet';
import type { IsoIssue, PipingNetwork } from '../model';

export const GA_ANNOTATIONS = ['line_label', 'cl_elevation', 'bop_elevation', 'flow_arrow'] as const;
export type GaAnnotation = (typeof GA_ANNOTATIONS)[number];
export const GA_DIRECTIONS = ['north', 'south', 'east', 'west'] as const;
export type GaDirection = (typeof GA_DIRECTIONS)[number];

export interface GaLine {
  /** The id the line is addressed by. */
  readonly id: string;
  readonly network: PipingNetwork;
  readonly graph: IsoGraph;
}

export interface GaOptions {
  readonly view: 'plan' | 'section';
  readonly direction: GaDirection;
  readonly cutAt?: number | undefined;
  readonly paper: PaperSize;
  readonly scale: number;
  readonly doubleLineFromDn: number;
  readonly annotate: readonly GaAnnotation[];
  readonly project: string;
}

export interface GaLabel {
  readonly kind: 'line' | 'cl_elevation' | 'bop_elevation';
  readonly text: string;
  readonly lineId: string;
  /** The 3D point the label belongs to (world mm). */
  readonly at: Vec3;
  /** Anchor on the sheet, paper mm (y up). */
  readonly sheet: readonly [number, number];
  /** The number the label shows, mm (elevations). */
  readonly valueMm?: number;
  readonly rotationDeg?: number;
}

export interface GaArrow {
  readonly lineId: string;
  readonly run: number;
  readonly at: Vec3;
  /** Unit flow direction in 3D. */
  readonly direction: Vec3;
  readonly sheet: readonly [number, number];
}

export interface GaLineRow {
  readonly lineId: string;
  readonly dn: number;
  readonly outsideDiameterMm: number;
  readonly spec: string | null;
  readonly doubleLine: boolean;
  readonly drawnSegments: number;
}

export interface Ga {
  readonly width: number;
  readonly height: number;
  readonly primitives: readonly IsoPrimitive[];
  readonly labels: readonly GaLabel[];
  readonly arrows: readonly GaArrow[];
  readonly lines: readonly GaLineRow[];
  readonly warnings: readonly IsoIssue[];
  /** Extent of the drawing on the sheet, paper mm. */
  readonly extentMm: readonly [number, number];
  readonly fits: boolean;
  readonly title: string;
}

const FLOW_ARROW_MIN_MM = 1000;
const TEXT_SIZE = 2.5;
const HORIZONTAL = new Set(['+E', '-E', '+N', '-N', 'slope']);
const round2 = (value: number): number => Number(value.toFixed(2)) + 0;
const signed2 = (value: number): string => (value === 0 ? '0' : `${value > 0 ? '+' : '-'}${Number(Math.abs(value).toFixed(2))}`);

/** Plan: east right, north up. Section: the horizontal axis the viewer sees, vertical = up (the viewer stands on `direction`). */
function projector(options: Pick<GaOptions, 'view' | 'direction'>): (point: Vec3) => Vec2 {
  if (options.view === 'plan') return (point) => [point[0], point[1]];
  switch (options.direction) {
    case 'south':
      return (point) => [point[0], point[2]];
    case 'north':
      return (point) => [-point[0], point[2]];
    case 'east':
      return (point) => [point[1], point[2]];
    case 'west':
      return (point) => [-point[1], point[2]];
  }
}

/** Depth coordinate cut by `cutAt` and the side kept (the model nearer to the viewer than the cut is removed). */
function keptSide(direction: GaDirection): { axis: 0 | 1; keep: 1 | -1 } {
  switch (direction) {
    case 'south':
      return { axis: 1, keep: 1 };
    case 'north':
      return { axis: 1, keep: -1 };
    case 'east':
      return { axis: 0, keep: -1 };
    case 'west':
      return { axis: 0, keep: 1 };
  }
}

/** The part of segment a-b on the kept side of the cut, with whether it was cut. */
function clip(a: Vec3, b: Vec3, cutAt: number | undefined, direction: GaDirection): { a: Vec3; b: Vec3; cut: Vec3 | null } | null {
  if (cutAt === undefined) return { a, b, cut: null };
  const { axis, keep } = keptSide(direction);
  const [da, db] = [(a[axis] - cutAt) * keep, (b[axis] - cutAt) * keep];
  if (da < 0 && db < 0) return null;
  if (da >= 0 && db >= 0) return { a, b, cut: null };
  const t = da / (da - db);
  const point: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return da < 0 ? { a: point, b, cut: point } : { a, b: point, cut: point };
}

/** The part of a straight run on the kept side of the cut (the run itself without a cut), as a run; none when it is wholly removed. */
function clippedRun(run: IsoRun, cutAt: number | undefined, direction: GaDirection): IsoRun[] {
  const first = run.points[0];
  const last = run.points[run.points.length - 1];
  if (cutAt === undefined || first === undefined || last === undefined) return [run];
  const part = clip(first, last, cutAt, direction);
  if (part === null) return [];
  const { axis, keep } = keptSide(direction);
  const inner = run.points.slice(1, -1).filter((point) => (point[axis] - cutAt) * keep >= 0);
  return [{ ...run, points: [part.a, ...inner, part.b] }];
}

interface Drawn {
  readonly line: GaLine;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly cut: Vec3 | null;
}

const mix = (p: Vec2, q: Vec2, t: number): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** The longest run of `runs` by projected length (ties: first). */
function longestRun(runs: readonly IsoRun[], project: (point: Vec3) => Vec2): IsoRun | undefined {
  let best: { run: IsoRun; length: number } | undefined;
  for (const run of runs) {
    const first = run.points[0];
    const last = run.points[run.points.length - 1];
    if (first === undefined || last === undefined) continue;
    const [p, q] = [project(first), project(last)];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (best === undefined || length > best.length + 1e-9) best = { run, length };
  }
  return best?.run;
}

export function buildPipingGa(lines: readonly GaLine[], options: GaOptions): Ga {
  const project = projector(options);
  const [width, height] = PAPER_MM[options.paper];
  const area = sheetDrawingArea(width, height);
  const bottom = height - (area.y + area.height);
  const warnings: IsoIssue[] = [];
  const drawn: Drawn[] = lines.flatMap((line) =>
    line.graph.steps.flatMap((step): Drawn[] => {
      const part = clip(step.start, step.end, options.cutAt, options.direction);
      return part === null ? [] : [{ line, ...part }];
    }),
  );
  const points = drawn.flatMap((segment) => [project(segment.a), project(segment.b)]);
  const [minX, minY] = [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))];
  const [maxX, maxY] = [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
  const extent: [number, number] = points.length === 0 ? [0, 0] : [(maxX - minX) / options.scale, (maxY - minY) / options.scale];
  const margin = 24;
  const fits = extent[0] <= area.width - 2 * margin && extent[1] <= area.height - 2 * margin;
  if (!fits)
    warnings.push(
      isoIssue(
        'ISO_GA_OVERFLOW',
        'warning',
        `the drawing is ${Math.round(extent[0])} x ${Math.round(extent[1])} mm at 1:${options.scale}, larger than the ${Math.round(area.width - 2 * margin)} x ${Math.round(area.height - 2 * margin)} mm area of ${options.paper}`,
        lines.map((line) => line.id),
      ),
    );
  const origin: Vec2 = [
    area.x + margin + Math.max(0, (area.width - 2 * margin - extent[0]) / 2),
    bottom + margin + Math.max(0, (area.height - 2 * margin - extent[1]) / 2),
  ];
  const sheet = (point: Vec3): Vec2 => {
    const [x, y] = project(point);
    return [origin[0] + (x - minX) / options.scale, origin[1] + (y - minY) / options.scale];
  };
  const primitives: IsoPrimitive[] = [];
  const rows: GaLineRow[] = [];
  const labels: GaLabel[] = [];
  const arrows: GaArrow[] = [];
  for (const line of lines) {
    const pipe = line.network.components.find((component) => component.type === 'PIPE');
    const dn = pipe?.ends[0]?.boreMm ?? 0;
    const od = outsideDiameterMm(dn) ?? dn;
    const spec = line.network.attributes['PIPING-SPEC'] ?? null;
    const double = dn >= options.doubleLineFromDn;
    const own = drawn.filter((segment) => segment.line === line);
    for (const segment of own) {
      const [p, q] = [sheet(segment.a), sheet(segment.b)];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const radius = od / 2 / options.scale;
      if (length < 1e-6) {
        primitives.push({ t: 'circle', layer: 'ISO-PIPE', c: p, r: double ? Math.max(radius, 0.4) : 0.8 });
        continue;
      }
      if (!double) {
        primitives.push({ t: 'line', layer: 'ISO-PIPE', a: p, b: q });
        continue;
      }
      const normal: Vec2 = [(-(q[1] - p[1]) / length) * radius, ((q[0] - p[0]) / length) * radius];
      primitives.push(
        { t: 'line', layer: 'ISO-PIPE', a: [p[0] + normal[0], p[1] + normal[1]], b: [q[0] + normal[0], q[1] + normal[1]] },
        { t: 'line', layer: 'ISO-PIPE', a: [p[0] - normal[0], p[1] - normal[1]], b: [q[0] - normal[0], q[1] - normal[1]] },
      );
    }
    for (const segment of own)
      if (segment.cut !== null)
        primitives.push({ t: 'circle', layer: 'ISO-SYMB', c: sheet(segment.cut), r: Math.max(od / 2 / options.scale, 0.8) });
    rows.push({ lineId: line.id, dn, outsideDiameterMm: od, spec, doubleLine: double, drawnSegments: own.length });
    const runs = line.graph.runs.flatMap((run) => clippedRun(run, options.cutAt, options.direction));
    const longest = longestRun(runs, project);
    if (options.annotate.includes('line_label') && longest !== undefined) {
      const [first, last] = [longest.points[0] as Vec3, longest.points[longest.points.length - 1] as Vec3];
      const [p, q] = [sheet(first), sheet(last)];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const angle = length < 1e-6 ? 0 : (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
      const rotation = angle > 90 ? angle - 180 : angle <= -90 ? angle + 180 : angle;
      const middle = mix(p, q, 0.5);
      const radians = (rotation * Math.PI) / 180;
      const lift = od / 2 / options.scale + 3;
      const label = `${line.network.lineId}-DN${dn}${spec === null ? '' : `-${spec}`}`;
      const at: Vec2 = [middle[0] - Math.sin(radians) * lift, middle[1] + Math.cos(radians) * lift];
      primitives.push({ t: 'text', layer: 'ISO-TEXT', at, size: TEXT_SIZE, text: label, anchor: 'middle', rotation });
      labels.push({
        kind: 'line',
        text: label,
        lineId: line.network.lineId,
        at: [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, (first[2] + last[2]) / 2],
        sheet: [round2(at[0]), round2(at[1])],
        rotationDeg: round2(rotation),
      });
    }
    const levels = new Map<number, IsoRun[]>();
    for (const run of runs.filter((candidate) => HORIZONTAL.has(candidate.axis)))
      for (const point of run.axis === 'slope' ? [run.points[0], run.points[run.points.length - 1]] : [run.points[0]]) {
        if (point === undefined) continue;
        const key = Number(point[2].toFixed(1));
        levels.set(key, [...(levels.get(key) ?? []), run]);
      }
    for (const [elevation, atLevel] of levels) {
      const run = longestRun(atLevel, project);
      const first = run?.points[0];
      const last = run?.points[run.points.length - 1];
      if (run === undefined || first === undefined || last === undefined) continue;
      const [p, q] = [sheet(first), sheet(last)];
      const middle = mix(p, q, 0.5);
      const at3: Vec3 = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, elevation];
      const below = od / 2 / options.scale + 3;
      if (options.annotate.includes('cl_elevation')) {
        const at: Vec2 = [middle[0], middle[1] - below];
        primitives.push({ t: 'text', layer: 'ISO-TEXT', at, size: TEXT_SIZE, text: `CL EL ${signed(elevation)}`, anchor: 'middle' });
        labels.push({
          kind: 'cl_elevation',
          text: `CL EL ${signed(elevation)}`,
          lineId: line.network.lineId,
          at: at3,
          sheet: [round2(at[0]), round2(at[1])],
          valueMm: elevation,
        });
      }
      if (options.annotate.includes('bop_elevation')) {
        const bop = round2(elevation - od / 2);
        const at: Vec2 = [middle[0], middle[1] - below - 4];
        primitives.push({ t: 'text', layer: 'ISO-TEXT', at, size: TEXT_SIZE, text: `BOP EL ${signed2(bop)}`, anchor: 'middle' });
        labels.push({
          kind: 'bop_elevation',
          text: `BOP EL ${signed2(bop)}`,
          lineId: line.network.lineId,
          at: at3,
          sheet: [round2(at[0]), round2(at[1])],
          valueMm: bop,
        });
      }
    }
    if (options.annotate.includes('flow_arrow'))
      for (const run of runs) {
        const [first, last] = [run.points[0], run.points[run.points.length - 1]];
        if (first === undefined || last === undefined || distance3(first, last) <= FLOW_ARROW_MIN_MM) continue;
        const [p, q] = [sheet(first), sheet(last)];
        const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (length < 8) continue;
        const u: Vec2 = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
        const tip = mix(p, q, 0.5);
        const back: Vec2 = [tip[0] - u[0] * 3.5, tip[1] - u[1] * 3.5];
        primitives.push(
          { t: 'line', layer: 'ISO-SYMB', a: back, b: tip },
          { t: 'line', layer: 'ISO-SYMB', a: tip, b: [tip[0] - u[0] * 1.8 - u[1] * 1, tip[1] - u[1] * 1.8 + u[0] * 1] },
          { t: 'line', layer: 'ISO-SYMB', a: tip, b: [tip[0] - u[0] * 1.8 + u[1] * 1, tip[1] - u[1] * 1.8 - u[0] * 1] },
        );
        const span = distance3(first, last);
        arrows.push({
          lineId: line.network.lineId,
          run: run.id,
          at: [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, (first[2] + last[2]) / 2],
          direction: [(last[0] - first[0]) / span, (last[1] - first[1]) / span, (last[2] - first[2]) / span],
          sheet: [round2(tip[0]), round2(tip[1])],
        });
      }
  }
  const north: Vec2 = [width - 40, height - 40];
  const frame: IsoPrimitive[] = [
    rect(20, 10, width - 10, height - 10, 'ISO-FRAME'),
    text([area.x + 2, height - 20], 5, 'NOT FOR CONSTRUCTION'),
    text([area.x + 2, height - 25], 2.6, `REVIEW REQUIRED - piping general arrangement, scale 1:${options.scale}`),
    ...(options.view === 'plan'
      ? [
          { t: 'circle', layer: 'ISO-FRAME', c: north, r: 9 } as IsoPrimitive,
          { t: 'line', layer: 'ISO-FRAME', a: north, b: [north[0], north[1] + 8] } as IsoPrimitive,
          text([north[0] - 1, north[1] + 10], 3, 'N'),
        ]
      : []),
    ...titleBlock(width, [
      [
        ['PROJECT', options.project],
        ['VIEW', options.view === 'plan' ? 'PIPING PLAN' : `PIPING SECTION FROM ${options.direction.toUpperCase()}`],
        ['SCALE', `1:${options.scale}`],
      ],
      [
        ['LINES', lines.map((line) => line.network.lineId).join(' ')],
        ['PAPER', options.paper],
        ['CUT AT', options.cutAt === undefined ? '-' : String(options.cutAt)],
      ],
      [
        ['STATUS', 'NOT FOR CONSTRUCTION'],
        ['DRAWING', 'GENERAL ARRANGEMENT'],
        ['', ''],
      ],
    ]),
  ];
  return {
    width,
    height,
    primitives: [...primitives, ...frame],
    labels,
    arrows,
    lines: rows,
    warnings,
    extentMm: [round2(extent[0]), round2(extent[1])],
    fits,
    title: `piping GA ${options.view} 1:${options.scale}`,
  };
}
