/** DXF entity records read into world-space primitive shapes (one reader per entity type; the block-insert walk lives in dxfRead). */

import type { Vec3 } from '../model/vectors';
import { positiveSweep, toRadians } from './angle';
import { arcPolyline } from './arc';
import { type DxfRecord, codeNumber, codeValue, decodeDxfText, decodeTextControls, point } from './dxfRecord';
import { llullXdata, readHatch, readSpline } from './dxfReadShapes';

/** What an exported polyline stands for: a rectangle, or one loop of the region with that ordinal. */
type DxfPolylineMark = { readonly kind: 'rectangle' } | { readonly kind: 'region'; readonly ordinal: number };

export type DxfShape =
  | { readonly kind: 'line'; readonly a: Vec3; readonly b: Vec3 }
  | { readonly kind: 'polyline'; readonly points: readonly Vec3[]; readonly closed: boolean; readonly mark: DxfPolylineMark | null }
  | {
      readonly kind: 'arc';
      readonly center: Vec3;
      readonly radius: number;
      /** Radians, counter-clockwise. */
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'circle'; readonly center: Vec3; readonly radius: number }
  | { readonly kind: 'point'; readonly at: Vec3 }
  | {
      readonly kind: 'text';
      readonly at: Vec3;
      readonly height: number;
      readonly rotation: number;
      readonly content: string;
      readonly anchor: 'left' | 'center' | 'right';
    }
  /** Complete ellipse (an elliptical arc is a polyline); `major` is the semi-major vector from the centre, `ratio` minor / major. */
  | { readonly kind: 'ellipse'; readonly center: Vec3; readonly major: Vec3; readonly ratio: number }
  | { readonly kind: 'spline'; readonly points: readonly Vec3[]; readonly closed: boolean; readonly exact: boolean }
  | {
      readonly kind: 'hatch';
      readonly loops: readonly Vec3[][];
      readonly solid: boolean;
      readonly angle: number;
      readonly spacing: number;
      readonly cross: boolean;
    }
  | { readonly kind: 'face'; readonly corners: readonly Vec3[] };

/** The shape of an entity, the skipped-entity counter key when it cannot be read, or null when it has no shape. */
export type ShapeResult = DxfShape | { readonly skip: string } | null;

/** World transform of nested block inserts. */
export interface Transform {
  readonly apply: (point: Vec3) => Vec3;
  /** Rotation added to angles (radians). */
  readonly rotation: number;
  /** Uniform scale, or null when non-uniform / mirrored (arcs become polylines). */
  readonly scale: number | null;
}

type World = (local: Vec3) => Vec3;

/** Polyline mark of an LWPOLYLINE written by `export_dxf` (extended data), or null. */
function polylineMark(record: DxfRecord, vertices: number, closed: boolean): DxfPolylineMark | null {
  const xdata = llullXdata(record);
  if (xdata?.tag === 'rectangle' && vertices === 4 && closed) return { kind: 'rectangle' };
  if (xdata?.tag === 'region' && closed && xdata.ints[0] !== undefined) return { kind: 'region', ordinal: xdata.ints[0] };
  return null;
}

/** Points of an ellipse (or elliptical arc) from parameter `start` to `end`, 48 segments per turn at least. */
function ellipsePoints(center: Vec3, major: Vec3, ratio: number, start: number, end: number): Vec3[] {
  const sweep = positiveSweep(end - start);
  const minor: Vec3 = [-major[1] * ratio, major[0] * ratio, 0];
  const segments = Math.max(8, Math.ceil(sweep / (Math.PI / 24)));
  return Array.from({ length: segments + 1 }, (_, i): Vec3 => {
    const t = start + (sweep * i) / segments;
    return [
      center[0] + major[0] * Math.cos(t) + minor[0] * Math.sin(t),
      center[1] + major[1] * Math.cos(t) + minor[1] * Math.sin(t),
      center[2] + major[2] * Math.cos(t),
    ];
  });
}

/** Arc points from `start` to `end` (radians, CCW) around `center`. */
function arcPoints(center: Vec3, radius: number, start: number, end: number): Vec3[] {
  const sweep = positiveSweep(end - start);
  const segments = Math.max(4, Math.ceil(sweep / (Math.PI / 24)));
  return arcPolyline([center[0], center[1]], radius, start, sweep, segments).map(([x, y]): Vec3 => [x, y, center[2]]);
}

/** LWPOLYLINE vertices with bulge arcs densified, at `elevation`. */
function lwPolylinePoints(record: DxfRecord, closed: boolean): Vec3[] {
  const elevation = codeNumber(record, 38, 0);
  const vertices: Array<{ x: number; y: number; bulge: number }> = [];
  for (const [code, value] of record.codes) {
    if (code === 10) vertices.push({ x: Number(value), y: 0, bulge: 0 });
    const last = vertices[vertices.length - 1];
    if (last && code === 20) last.y = Number(value);
    if (last && code === 42) last.bulge = Number(value);
  }
  const result: Vec3[] = [];
  const finite = vertices.filter((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y));
  if (!Number.isFinite(elevation)) return [];
  finite.forEach((vertex, index) => {
    result.push([vertex.x, vertex.y, elevation]);
    const next = finite[index + 1] ?? (closed ? finite[0] : undefined);
    if (!next || vertex.bulge === 0 || !Number.isFinite(vertex.bulge)) return;
    const chord = Math.hypot(next.x - vertex.x, next.y - vertex.y);
    if (chord === 0) return;
    const theta = 4 * Math.atan(vertex.bulge);
    const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const midX = (vertex.x + next.x) / 2;
    const midY = (vertex.y + next.y) / 2;
    const sagitta = radius * Math.cos(theta / 2);
    const normal = [-(next.y - vertex.y) / chord, (next.x - vertex.x) / chord];
    const sign = vertex.bulge > 0 ? 1 : -1;
    const center: Vec3 = [midX + sign * (normal[0] as number) * sagitta, midY + sign * (normal[1] as number) * sagitta, elevation];
    const startAngle = Math.atan2(vertex.y - center[1], vertex.x - center[0]);
    const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
    for (let k = 1; k < steps; k++) {
      const angle = startAngle + (theta * k) / steps;
      result.push([center[0] + Math.abs(radius) * Math.cos(angle), center[1] + Math.abs(radius) * Math.sin(angle), elevation]);
    }
  });
  return result;
}

const MTEXT_TOKEN = /\\([\\{}])|\\U\+([0-9A-Fa-f]{4})|\\P|\\[A-Za-z][^;\\{}]*;|\\~|[{}]/g;

/** MTEXT contents: `\P` is a line break; `\\`, `\{`, `\}` and `\U+XXXX` are decoded; other formatting codes and unescaped braces are dropped. */
function stripMText(text: string): string {
  return text
    .replace(MTEXT_TOKEN, (match, literal?: string, unicode?: string) => {
      if (literal !== undefined) return literal;
      if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
      return match === '\\P' ? '\n' : match === '\\~' ? ' ' : '';
    })
    .trim();
}

/** True when the entity's extrusion direction is -Z (mirrored OCS: x is negated). */
function mirrored(record: DxfRecord): boolean {
  return codeNumber(record, 230, 1) < 0;
}

export function ocs(record: DxfRecord, local: Vec3): Vec3 {
  return mirrored(record) ? [-local[0], local[1], -local[2]] : local;
}

export function lwPolylineShape(record: DxfRecord, world: World): ShapeResult {
  const closed = (codeNumber(record, 70, 0) & 1) === 1;
  const points = lwPolylinePoints(record, closed).map(world);
  const mark = polylineMark(record, points.length, closed);
  return points.length >= 2 ? { kind: 'polyline', points, closed, mark } : null;
}

export function polylineShape(record: DxfRecord, world: World): ShapeResult {
  const flags = codeNumber(record, 70, 0);
  if ((flags & (16 | 64)) !== 0) return { skip: 'POLYLINE mesh' };
  const elevation = codeNumber(record, 30, 0);
  const points = (record.vertices ?? []).map((vertex) => {
    const local = point(vertex);
    return world((flags & 8) === 8 ? local : [local[0], local[1], elevation]);
  });
  return points.length >= 2 ? { kind: 'polyline', points, closed: (flags & 1) === 1, mark: null } : null;
}

/** ARC and CIRCLE: an arc / circle when the transform keeps circles round, else a polyline. */
export function arcShape(record: DxfRecord, world: World, transform: Transform): ShapeResult {
  const local = point(record);
  const radius = codeNumber(record, 40, 0);
  if (!(radius > 0)) return null;
  let start = record.type === 'ARC' ? toRadians(codeNumber(record, 50, 0)) : 0;
  let end = record.type === 'ARC' ? toRadians(codeNumber(record, 51, 360)) : 0;
  if (mirrored(record)) [start, end] = [Math.PI - end, Math.PI - start];
  const center = world(local);
  if (transform.scale === null) {
    const points = arcPoints(ocs(record, local), radius, start, record.type === 'ARC' ? end : Math.PI * 2).map((p) => transform.apply(p));
    return { kind: 'polyline', points, closed: record.type === 'CIRCLE', mark: null };
  }
  if (record.type === 'CIRCLE') return { kind: 'circle', center, radius: radius * transform.scale };
  return { kind: 'arc', center, radius: radius * transform.scale, start: start + transform.rotation, end: end + transform.rotation };
}

/** TEXT and MTEXT: content, anchor, rotation and height; MTEXT attached at the top of its first line is moved to its baseline. */
export function textShape(record: DxfRecord, world: World, transform: Transform): ShapeResult {
  const raw =
    record.type === 'MTEXT'
      ? stripMText(
          record.codes
            .filter(([code]) => code === 3 || code === 1)
            .map(([, value]) => value)
            .join(''),
        )
      : decodeTextControls(decodeDxfText(codeValue(record, 1) ?? '')).trim();
  if (raw === '') return null;
  const localHeight = codeNumber(record, 40, 1);
  const height = localHeight * (transform.scale ?? 1);
  const isMText = record.type === 'MTEXT';
  const alignment = isMText ? 0 : codeNumber(record, 72, 0);
  const attachment = isMText ? codeNumber(record, 71, 1) : 0;
  const column = isMText ? (attachment - 1) % 3 : alignment;
  const anchor = column === 1 ? 'center' : column === 2 ? 'right' : 'left';
  const direction =
    isMText && codeValue(record, 11) !== undefined ? Math.atan2(codeNumber(record, 21, 0), codeNumber(record, 11, 1)) : null;
  const angle = direction ?? toRadians(codeNumber(record, 50, 0));
  const anchorPoint = point(record, isMText || anchor === 'left' ? 0 : 1);
  // an MTEXT inserted at the top of its first line (attachments 1-3) has its baseline one cap height lower
  const base: Vec3 =
    isMText && attachment >= 1 && attachment <= 3 && localHeight > 0
      ? [anchorPoint[0] + Math.sin(angle) * localHeight, anchorPoint[1] - Math.cos(angle) * localHeight, anchorPoint[2]]
      : anchorPoint;
  return { kind: 'text', anchor, at: world(base), height: height > 0 ? height : 1, rotation: angle + transform.rotation, content: raw };
}

/** ELLIPSE: a complete ellipse when the transform keeps it one, else a polyline. */
export function ellipseShape(record: DxfRecord, transform: Transform): ShapeResult {
  const [center, major] = [point(record), point(record, 1)];
  const ratio = codeNumber(record, 40, 1);
  const [start, end] = [codeNumber(record, 41, 0), codeNumber(record, 42, Math.PI * 2)];
  if (!(ratio > 0 && ratio <= 1) || !(Math.hypot(major[0], major[1], major[2]) > 0)) return null;
  if (transform.scale === null || Math.abs(positiveSweep(end - start) - Math.PI * 2) > 1e-9) {
    const points = ellipsePoints(center, major, ratio, start, end).map((p) => transform.apply(p));
    return { kind: 'polyline', points, closed: Math.abs(positiveSweep(end - start) - Math.PI * 2) < 1e-9, mark: null };
  }
  const worldCenter = transform.apply(center);
  const tip = transform.apply([center[0] + major[0], center[1] + major[1], center[2] + major[2]]);
  return {
    kind: 'ellipse',
    center: worldCenter,
    major: [tip[0] - worldCenter[0], tip[1] - worldCenter[1], tip[2] - worldCenter[2]],
    ratio,
  };
}

export function splineShape(record: DxfRecord, transform: Transform): ShapeResult {
  const spline = readSpline(record);
  if (spline === null) return { skip: 'SPLINE (malformed)' };
  return { kind: 'spline', ...spline, points: spline.points.map(transform.apply) };
}

export function hatchShape(record: DxfRecord, world: World): ShapeResult {
  const hatch = readHatch(record);
  const elevation = codeNumber(record, 30, 0);
  if (hatch === null) return { skip: 'HATCH (unreadable boundary)' };
  return { kind: 'hatch', ...hatch, loops: hatch.loops.map((loop) => loop.map(([x, y]) => world([x, y, elevation]))) };
}

export function faceShape(record: DxfRecord, world: World): ShapeResult {
  const corners = [0, 1, 2, 3].map((k) => world(point(record, k)));
  const [, , c, d] = corners as [Vec3, Vec3, Vec3, Vec3];
  const unique = c[0] === d[0] && c[1] === d[1] && c[2] === d[2] ? corners.slice(0, 3) : corners;
  return { kind: 'face', corners: unique };
}
