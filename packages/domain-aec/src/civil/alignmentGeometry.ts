/**
 * Horizontal alignment geometry: tangents through PIs joined by simple circular curves.
 * All lengths and stations are in document units; angles in radians (0 = +X, counter-clockwise).
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import {
  nearestAlongSpiral,
  spiralCurve,
  spiralPointAt,
  spiralSweep,
  type SpiralCurve,
  type SpiralElement,
} from './alignmentSpiral';

export type { SpiralElement } from './alignmentSpiral';

export type HorizontalInput = Pick<AlignmentObject, 'points' | 'radii' | 'startStation'> &
  Partial<Pick<AlignmentObject, 'spirals'>>;

export interface LineElement {
  readonly kind: 'line';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly startStation: number;
  readonly length: number;
  readonly direction: number;
}

export interface ArcElement {
  readonly kind: 'arc';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly center: Vec2;
  readonly radius: number;
  readonly rotation: 'cw' | 'ccw';
  /** The point of intersection of the two tangents. */
  readonly pi: Vec2;
  /** Central angle of the arc (radians); equals the tangent deflection without spirals. */
  readonly deflection: number;
  readonly startStation: number;
  readonly length: number;
}

export type HorizontalElement = LineElement | ArcElement | SpiralElement;

export interface StationOffset {
  readonly station: number;
  /** Signed distance from the centreline, positive to the left of the direction of travel. */
  readonly offset: number;
  readonly distance: number;
  readonly point: Vec2;
}

const EPS = 1e-9;
/** Largest chord angle when an arc is drawn or sampled (5 degrees). */
export const MAX_ARC_STEP = Math.PI / 36;

interface Curve {
  readonly pi: Vec2;
  readonly radius: number;
  readonly tangent: number;
  readonly pc: Vec2;
  readonly pt: Vec2;
  readonly center: Vec2;
  readonly rotation: 'cw' | 'ccw';
  readonly deflection: number;
  /** Clothoid constants when the curve has transition spirals. */
  readonly spiral: SpiralCurve | null;
  readonly ts: Vec2;
  readonly st: Vec2;
  readonly heading: number;
  readonly exitHeading: number;
}

function unit(from: Vec2, to: Vec2): Vec2 {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

function curveAt(
  points: ReadonlyArray<Vec2>,
  radii: ReadonlyArray<number>,
  i: number,
  spirals: ReadonlyArray<number>,
): Curve | null {
  const radius = radii[i - 1] ?? 0;
  const before = points[i - 1] as Vec2;
  const pi = points[i] as Vec2;
  const after = points[i + 1] as Vec2;
  if (!(radius > 0)) return null;
  const d1 = unit(before, pi);
  const d2 = unit(pi, after);
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  const deflection = Math.atan2(Math.abs(cross), d1[0] * d2[0] + d1[1] * d2[1]);
  if (deflection < EPS) return null;
  const spiralLength = spirals[i - 1] ?? 0;
  const spiral = spiralLength > 0 ? spiralCurve(radius, spiralLength, deflection) : null;
  if (spiralLength > 0 && !spiral) return null;
  const tangent = spiral ? spiral.tangent : radius * Math.tan(deflection / 2);
  const ccw = cross > 0;
  const turn = ccw ? 1 : -1;
  const heading = Math.atan2(d1[1], d1[0]);
  const ts: Vec2 = [pi[0] - d1[0] * tangent, pi[1] - d1[1] * tangent];
  const st: Vec2 = [pi[0] + d2[0] * tangent, pi[1] + d2[1] * tangent];
  let pc = ts;
  let pt = st;
  let arcHeading = heading;
  if (spiral) {
    const local = (h: number, x: number, y: number): Vec2 => [
      x * Math.cos(h) - y * Math.sin(h),
      x * Math.sin(h) + y * Math.cos(h),
    ];
    const entry = local(heading, spiral.xs, turn * spiral.ys);
    const exit = local(heading + turn * deflection, spiral.xs, -turn * spiral.ys);
    pc = [ts[0] + entry[0], ts[1] + entry[1]];
    pt = [st[0] - exit[0], st[1] - exit[1]];
    arcHeading = heading + turn * spiral.theta;
  }
  const normal: Vec2 = [-Math.sin(arcHeading) * turn, Math.cos(arcHeading) * turn];
  return {
    pi,
    radius,
    tangent,
    pc,
    pt,
    center: [pc[0] + normal[0] * radius, pc[1] + normal[1] * radius],
    rotation: ccw ? 'ccw' : 'cw',
    deflection: spiral ? spiral.arcAngle : deflection,
    spiral,
    ts,
    st,
    heading,
    exitHeading: heading + turn * deflection,
  };
}

function tangentLengths(
  points: ReadonlyArray<Vec2>,
  radii: ReadonlyArray<number>,
  spirals: ReadonlyArray<number>,
): number[] {
  return points.map((_, i) =>
    i === 0 || i === points.length - 1 ? 0 : (curveAt(points, radii, i, spirals)?.tangent ?? 0),
  );
}

function spiralProblem(
  points: ReadonlyArray<Vec2>,
  radii: ReadonlyArray<number>,
  spirals: ReadonlyArray<number>,
): string | null {
  for (let i = 1; i < points.length - 1; i++) {
    const length = spirals[i - 1] ?? 0;
    const radius = radii[i - 1] ?? 0;
    if (!(length > 0)) continue;
    if (!(radius > 0)) return `PI ${i}: a spiral needs a curve radius > 0.`;
    const d1 = unit(points[i - 1] as Vec2, points[i] as Vec2);
    const d2 = unit(points[i] as Vec2, points[i + 1] as Vec2);
    const deflection = Math.atan2(
      Math.abs(d1[0] * d2[1] - d1[1] * d2[0]),
      d1[0] * d2[0] + d1[1] * d2[1],
    );
    if (deflection < EPS) continue;
    if (!spiralCurve(radius, length, deflection)) {
      const spiralAngle = length / (2 * radius);
      return (
        `PI ${i}: deflection ${((deflection * 180) / Math.PI).toFixed(3)} deg is smaller than twice ` +
        `the spiral angle (2 x ${((spiralAngle * 180) / Math.PI).toFixed(3)} deg for Ls ${length} ` +
        `and R ${radius}); shorten the spirals or reduce the radius.`
      );
    }
  }
  return null;
}

/** Error text for an unusable plan geometry, or null when `points` + `radii` are valid. */
export function validateHorizontal(
  points: ReadonlyArray<Vec2>,
  radii: ReadonlyArray<number>,
  spirals: ReadonlyArray<number> = [],
): string | null {
  if (points.length < 2) return 'an alignment needs at least 2 points.';
  if (!points.every((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))) {
    return 'points must be finite [x, y] pairs.';
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[i + 1] as Vec2;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) return `points ${i} and ${i + 1} coincide.`;
  }
  if (radii.length !== points.length - 2) {
    return `radii needs ${points.length - 2} value(s) (one per interior PI), got ${radii.length}.`;
  }
  if (!radii.every((radius) => Number.isFinite(radius) && radius >= 0)) {
    return 'radii must be finite numbers >= 0 (0 = no curve).';
  }
  if (spirals.length > 0 && spirals.length !== radii.length) {
    return `spirals needs ${radii.length} value(s) (one per interior PI), got ${spirals.length}.`;
  }
  if (!spirals.every((length) => Number.isFinite(length) && length >= 0)) {
    return 'spirals must be finite numbers >= 0 (0 = no spiral).';
  }
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    const c = points[i + 1] as Vec2;
    const d1 = unit(a, b);
    const d2 = unit(b, c);
    const reversal = d1[0] * d2[0] + d1[1] * d2[1] < -1 + 1e-9;
    if ((radii[i - 1] ?? 0) > 0 && reversal)
      return `PI ${i}: the alignment doubles back on itself.`;
  }
  const spiral = spiralProblem(points, radii, spirals);
  if (spiral !== null) return spiral;
  const tangents = tangentLengths(points, radii, spirals);
  for (let leg = 0; leg + 1 < points.length; leg++) {
    const a = points[leg] as Vec2;
    const b = points[leg + 1] as Vec2;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const used = (tangents[leg] ?? 0) + (tangents[leg + 1] ?? 0);
    if (used > length * (1 + 1e-9) + 1e-9) {
      const culprit = (tangents[leg] ?? 0) > 0 ? leg : leg + 1;
      return (
        `PI ${culprit}: curve tangents on the leg PI ${leg}-PI ${leg + 1} total ${used.toFixed(3)} ` +
        `but the leg is only ${length.toFixed(3)} long; reduce the radii or move the PIs.`
      );
    }
  }
  return null;
}

/** Ordered tangent / curve elements with their stations; [] when the geometry is invalid. */
export function horizontalElements(alignment: HorizontalInput): HorizontalElement[] {
  const { points, radii } = alignment;
  const spirals = alignment.spirals ?? [];
  if (validateHorizontal(points, radii, spirals) !== null) return [];
  const elements: HorizontalElement[] = [];
  let station = alignment.startStation;
  let cursor = points[0] as Vec2;
  const lineTo = (to: Vec2): void => {
    const length = Math.hypot(to[0] - cursor[0], to[1] - cursor[1]);
    if (length > EPS) {
      const direction = Math.atan2(to[1] - cursor[1], to[0] - cursor[0]);
      elements.push({
        kind: 'line',
        start: cursor,
        end: to,
        startStation: station,
        length,
        direction,
      });
      station += length;
    }
    cursor = to;
  };
  for (let i = 1; i < points.length - 1; i++) {
    const curve = curveAt(points, radii, i, spirals);
    if (!curve) {
      lineTo(points[i] as Vec2);
      continue;
    }
    lineTo(curve.ts);
    const spiralOf = (entry: boolean): SpiralElement => ({
      kind: 'spiral',
      start: entry ? curve.ts : curve.pt,
      end: entry ? curve.pc : curve.st,
      radiusStart: entry ? Infinity : curve.radius,
      radiusEnd: entry ? curve.radius : Infinity,
      length: curve.spiral?.length ?? 0,
      startStation: station,
      rotation: curve.rotation,
      pi: curve.pi,
      tangentPoint: entry ? curve.ts : curve.st,
      tangentHeading: entry ? curve.heading : curve.exitHeading,
    });
    if (curve.spiral) {
      const entry = spiralOf(true);
      elements.push(entry);
      station += entry.length;
    }
    const length = curve.radius * curve.deflection;
    if (length > EPS || !curve.spiral) {
      elements.push({
        kind: 'arc',
        start: curve.pc,
        end: curve.pt,
        center: curve.center,
        radius: curve.radius,
        rotation: curve.rotation,
        pi: curve.pi,
        deflection: curve.deflection,
        startStation: station,
        length,
      });
      station += length;
    }
    if (curve.spiral) {
      const exit = spiralOf(false);
      elements.push({ ...exit, startStation: station });
      station += exit.length;
    }
    cursor = curve.st;
  }
  lineTo(points[points.length - 1] as Vec2);
  return elements;
}

/** Total centreline length (0 when the geometry is invalid). */
export function alignmentLength(alignment: HorizontalInput): number {
  return horizontalElements(alignment).reduce((total, element) => total + element.length, 0);
}

function sweepOf(element: ArcElement | SpiralElement): number {
  return element.kind === 'arc' ? element.length / element.radius : spiralSweep(element);
}

function maxCurvature(element: ArcElement | SpiralElement): number {
  return element.kind === 'arc'
    ? 1 / element.radius
    : 1 / Math.min(element.radiusStart, element.radiusEnd);
}

function arcSign(arc: ArcElement): number {
  return arc.rotation === 'ccw' ? 1 : -1;
}

/** Point and travel direction on one element at `station` (clamped to the element). */
export function elementPointAt(
  element: HorizontalElement,
  station: number,
): { point: Vec2; direction: number } {
  const along = Math.min(Math.max(station - element.startStation, 0), element.length);
  if (element.kind === 'line') {
    return {
      point: [
        element.start[0] + Math.cos(element.direction) * along,
        element.start[1] + Math.sin(element.direction) * along,
      ],
      direction: element.direction,
    };
  }
  if (element.kind === 'spiral') return spiralPointAt(element, along);
  const start = Math.atan2(
    element.start[1] - element.center[1],
    element.start[0] - element.center[0],
  );
  const angle = start + (arcSign(element) * along) / element.radius;
  return {
    point: [
      element.center[0] + element.radius * Math.cos(angle),
      element.center[1] + element.radius * Math.sin(angle),
    ],
    direction: angle + (arcSign(element) * Math.PI) / 2,
  };
}

function elementAtStation(
  elements: ReadonlyArray<HorizontalElement>,
  station: number,
): HorizontalElement | undefined {
  return (
    elements.find((element) => station <= element.startStation + element.length) ??
    elements[elements.length - 1]
  );
}

/** Centreline point and travel direction at `station` (clamped to the alignment); null if invalid. */
export function pointAtStation(
  alignment: HorizontalInput,
  station: number,
): { point: Vec2; direction: number } | null {
  const element = elementAtStation(horizontalElements(alignment), station);
  return element ? elementPointAt(element, station) : null;
}

function nearestStationOnElement(element: HorizontalElement, xy: Vec2): number {
  if (element.kind === 'line') {
    const dx = xy[0] - element.start[0];
    const dy = xy[1] - element.start[1];
    const along = dx * Math.cos(element.direction) + dy * Math.sin(element.direction);
    return element.startStation + Math.min(Math.max(along, 0), element.length);
  }
  if (element.kind === 'spiral') return nearestAlongSpiral(element, xy);
  const sign = arcSign(element);
  const full = Math.PI * 2;
  const start = Math.atan2(
    element.start[1] - element.center[1],
    element.start[0] - element.center[0],
  );
  const angle = Math.atan2(xy[1] - element.center[1], xy[0] - element.center[0]);
  const relative = (((sign * (angle - start)) % full) + full) % full;
  const sweep = element.length / element.radius;
  const clamped = relative <= sweep ? relative : relative - sweep < full - relative ? sweep : 0;
  return element.startStation + clamped * element.radius;
}

/** Station, signed offset (left positive) and distance of the centreline point nearest `xy`. */
export function stationOffset(alignment: HorizontalInput, xy: Vec2): StationOffset | null {
  let best: StationOffset | null = null;
  for (const element of horizontalElements(alignment)) {
    const station = nearestStationOnElement(element, xy);
    const { point, direction } = elementPointAt(element, station);
    const dx = xy[0] - point[0];
    const dy = xy[1] - point[1];
    const distance = Math.hypot(dx, dy);
    if (best === null || distance < best.distance - EPS) {
      const left = Math.cos(direction) * dy - Math.sin(direction) * dx;
      best = { station, offset: distance < EPS ? 0 : Math.sign(left) * distance, distance, point };
    }
  }
  return best;
}

/** Station of the last point of the alignment (start station when invalid). */
export function endStation(alignment: HorizontalInput): number {
  return alignment.startStation + alignmentLength(alignment);
}

/** Centreline polyline with arcs densified to chords of at most 5 degrees. */
export function centrelinePoints(alignment: HorizontalInput): Vec2[] {
  const result: Vec2[] = [];
  for (const element of horizontalElements(alignment)) {
    if (result.length === 0) result.push(element.start);
    if (element.kind !== 'line') {
      const steps = Math.max(
        element.kind === 'spiral' ? 2 : 1,
        Math.ceil(sweepOf(element) / MAX_ARC_STEP),
      );
      for (let k = 1; k < steps; k++) {
        result.push(
          elementPointAt(element, element.startStation + (element.length * k) / steps).point,
        );
      }
    }
    result.push(element.end);
  }
  return result;
}

const MAX_SAMPLES = 2000;

/**
 * Ascending stations for sampling: start, end, every `interval` from the start, curve PC / PT,
 * any `extra` stations, with arcs subdivided to chords of at most 5 degrees. Capped at ~2000.
 */
export function sampleStations(
  alignment: HorizontalInput,
  interval: number,
  extra: ReadonlyArray<number> = [],
): number[] {
  const elements = horizontalElements(alignment);
  if (elements.length === 0) return [];
  const start = alignment.startStation;
  const end = endStation(alignment);
  const step = Math.max(interval, (end - start) / MAX_SAMPLES, EPS);
  const raw = [start, end, ...elements.map((element) => element.startStation)];
  for (let s = start + step; s < end - EPS; s += step) raw.push(s);
  for (const s of extra) if (s > start && s < end) raw.push(s);
  raw.sort((a, b) => a - b);
  const stations: number[] = [];
  for (const s of raw) {
    if (stations.length === 0 || s - (stations[stations.length - 1] as number) > 1e-6)
      stations.push(s);
  }
  const dense: number[] = [];
  stations.forEach((s0, index) => {
    dense.push(s0);
    const s1 = stations[index + 1];
    if (s1 === undefined) return;
    const element = elementAtStation(elements, (s0 + s1) / 2);
    if (!element || element.kind === 'line') return;
    const parts = Math.ceil(((s1 - s0) * maxCurvature(element)) / MAX_ARC_STEP);
    for (let k = 1; k < parts; k++) dense.push(s0 + ((s1 - s0) * k) / parts);
  });
  return dense;
}
