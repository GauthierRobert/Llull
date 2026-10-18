/**
 * Model-space construction of a `dimension` entity from the entities it references: the measured value, the extension / dimension lines
 * with their arrowheads, and the label anchor. Shared by the 2D viewport and render_view; plane geometry is in world XY at the
 * references' z (rotated work planes are honoured through `planeToWorld`).
 */

import type { DimensionEntity, Entity, Vec2 } from '../model/types';
import { planeToWorld } from './workPlane';

export const DEFAULT_DIMENSION_OFFSET = 5;
const DEFAULT_ARROW_SIZE = 0.3;
const ANGULAR_ARC_SEGMENTS = 32;
const EPSILON = 1e-9;

type DimensionSegment = readonly [Vec2, Vec2];

export interface DimensionDrawing {
  /** Length, radius or diameter in model units; degrees for an angular dimension. */
  value: number;
  /** Label anchor (centre of the text). */
  textAt: Vec2;
  /** Every stroke: extension lines, dimension line / arc, arrowheads. */
  segments: DimensionSegment[];
  /** Elevation of the construction (z of the first reference). */
  z: number;
}

type Refs = ReadonlyArray<Entity | null | undefined>;
type Radial = Extract<Entity, { kind: 'circle' | 'arc' | 'ellipse' }>;
type LineEntity = Extract<Entity, { kind: 'line' }>;
type Locatable = LineEntity | Extract<Entity, { kind: 'point' }>;

const isLocatable = (e: Entity | null | undefined): e is Locatable => e?.kind === 'point' || e?.kind === 'line';
const isRadial = (e: Entity | null | undefined): e is Radial => e?.kind === 'circle' || e?.kind === 'arc' || e?.kind === 'ellipse';
const isLine = (e: Entity | null | undefined): e is LineEntity => e?.kind === 'line';

const toWorld = (e: Entity, local: Vec2): Vec2 => {
  const world = planeToWorld(e.position, e.rotation, local);
  return [world[0], world[1]];
};

const centroid = (e: Locatable): Vec2 =>
  e.kind === 'point' ? toWorld(e, [0, 0]) : toWorld(e, [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]);

/** Two wing segments of an arrowhead at `tip` pointing along (dx, dy). */
function arrowhead(tip: Vec2, dx: number, dy: number, size: number): DimensionSegment[] {
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return [];
  const [nx, ny] = [dx / length, dy / length];
  const wing = (side: number): DimensionSegment => [
    tip,
    [tip[0] - nx * size - ny * side * size * 0.5, tip[1] - ny * size + nx * side * size * 0.5],
  ];
  return [wing(1), wing(-1)];
}

/** Linear (horizontal or vertical, whichever dominates) or aligned (true distance) between two points. */
function linearDrawing(a: Vec2, b: Vec2, offset: number, aligned: boolean, size: number): Omit<DimensionDrawing, 'z'> {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return { value: 0, textAt: [a[0], a[1] + offset], segments: [] };
  const vertical = !aligned && Math.abs(dy) > Math.abs(dx);
  const [perpX, perpY] = [-dy / length, dx / length];
  const [dimA, dimB]: [Vec2, Vec2] = aligned
    ? [
        [a[0] + perpX * offset, a[1] + perpY * offset],
        [b[0] + perpX * offset, b[1] + perpY * offset],
      ]
    : vertical
      ? [
          [Math.max(a[0], b[0]) + offset, a[1]],
          [Math.max(a[0], b[0]) + offset, b[1]],
        ]
      : [
          [a[0], Math.max(a[1], b[1]) + offset],
          [b[0], Math.max(a[1], b[1]) + offset],
        ];
  const [dirX, dirY] = [dimB[0] - dimA[0], dimB[1] - dimA[1]];
  return {
    value: aligned ? length : vertical ? Math.abs(dy) : Math.abs(dx),
    textAt: [(dimA[0] + dimB[0]) / 2, (dimA[1] + dimB[1]) / 2],
    segments: [[a, dimA], [b, dimB], [dimA, dimB], ...arrowhead(dimA, -dirX, -dirY, size), ...arrowhead(dimB, dirX, dirY, size)],
  };
}

/** Radius (leader from the centre) or diameter (leader through the centre); `offset` doubles as the leader angle in radians when in (0, 2π). */
function radialDrawing(ref: Radial, offset: number, diameter: boolean, size: number): Omit<DimensionDrawing, 'z'> {
  const [cx, cy] = toWorld(ref, ref.center);
  const radius = ref.kind === 'ellipse' ? ref.radiusX : ref.radius;
  const angle = offset > 0 && offset < Math.PI * 2 ? offset : Math.PI / 4;
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const rim: Vec2 = [cx + ux * radius, cy + uy * radius];
  const far: Vec2 = [cx - ux * radius, cy - uy * radius];
  return {
    value: diameter ? radius * 2 : radius,
    textAt: [cx + ux * radius * 1.15, cy + uy * radius * 1.15],
    segments: [[diameter ? far : [cx, cy], rim], ...arrowhead(rim, ux, uy, size), ...(diameter ? arrowhead(far, -ux, -uy, size) : [])],
  };
}

/** Minor arc between the arms seen from `vertex`, with extension lines from the vertex. */
function angularDrawing(vertex: Vec2, armA: Vec2, armB: Vec2, offset: number): Omit<DimensionDrawing, 'z'> {
  const [vx, vy] = vertex;
  const angleA = Math.atan2(armA[1] - vy, armA[0] - vx);
  const angleB = Math.atan2(armB[1] - vy, armB[0] - vx);
  let sweep = angleB - angleA;
  if (sweep < 0) sweep += Math.PI * 2;
  const swapped = sweep > Math.PI;
  const startAngle = swapped ? angleB : angleA;
  const minorSweep = swapped ? Math.PI * 2 - sweep : sweep;
  const radius = offset > 0 ? offset : DEFAULT_DIMENSION_OFFSET;
  const onArc = (angle: number): Vec2 => [vx + Math.cos(angle) * radius, vy + Math.sin(angle) * radius];
  const arc = Array.from({ length: ANGULAR_ARC_SEGMENTS + 1 }, (_, i) => onArc(startAngle + (minorSweep * i) / ANGULAR_ARC_SEGMENTS));
  const midAngle = startAngle + minorSweep / 2;
  return {
    value: (minorSweep * 180) / Math.PI,
    textAt: [vx + Math.cos(midAngle) * radius * 1.4, vy + Math.sin(midAngle) * radius * 1.4],
    segments: [
      ...arc.slice(1).map((end, i): DimensionSegment => [arc[i] as Vec2, end]),
      [vertex, onArc(startAngle)],
      [vertex, onArc(startAngle + minorSweep)],
    ],
  };
}

/** Vertex (intersection of the two infinite lines) and the far endpoint of each line, or null for parallel lines. */
function lineAngle(first: LineEntity, second: LineEntity): [Vec2, Vec2, Vec2] | null {
  const [p, p2] = [toWorld(first, first.start), toWorld(first, first.end)];
  const [q, q2] = [toWorld(second, second.start), toWorld(second, second.end)];
  const [rx, ry] = [p2[0] - p[0], p2[1] - p[1]];
  const [sx, sy] = [q2[0] - q[0], q2[1] - q[1]];
  const cross = rx * sy - ry * sx;
  if (Math.abs(cross) < EPSILON * Math.hypot(rx, ry) * Math.hypot(sx, sy) || Math.hypot(rx, ry) < EPSILON) return null;
  const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / cross;
  const vertex: Vec2 = [p[0] + t * rx, p[1] + t * ry];
  const far = (a: Vec2, b: Vec2): Vec2 =>
    Math.hypot(a[0] - vertex[0], a[1] - vertex[1]) >= Math.hypot(b[0] - vertex[0], b[1] - vertex[1]) ? a : b;
  return [vertex, far(p, p2), far(q, q2)];
}

/**
 * The drawing of one dimension, or null when a reference is missing / of the wrong kind (or two angular lines are parallel). Angular takes
 * a vertex + 2 arms (3 refs, centroids) or 2 lines (the vertex is their intersection).
 * @failure missing or wrong-kind references -> null
 */
export function dimensionDrawing(
  kind: DimensionEntity['dimensionKind'],
  refs: Refs,
  offset: number,
  arrowSize: number = DEFAULT_ARROW_SIZE,
): DimensionDrawing | null {
  const [first, second, third] = refs;
  const z = first ? planeToWorld(first.position, first.rotation, [0, 0])[2] : 0;
  const at = (drawing: Omit<DimensionDrawing, 'z'> | null): DimensionDrawing | null => (drawing ? { ...drawing, z } : null);
  switch (kind) {
    case 'linear':
    case 'aligned':
      return isLocatable(first) && isLocatable(second)
        ? at(linearDrawing(centroid(first), centroid(second), offset, kind === 'aligned', arrowSize))
        : null;
    case 'radial':
    case 'diameter':
      return isRadial(first) ? at(radialDrawing(first, offset, kind === 'diameter', arrowSize)) : null;
    case 'angular': {
      if (third === undefined && isLine(first) && isLine(second)) {
        const corner = lineAngle(first, second);
        return corner ? at(angularDrawing(corner[0], corner[1], corner[2], offset)) : null;
      }
      return isLocatable(first) && isLocatable(second) && isLocatable(third)
        ? at(angularDrawing(centroid(first), centroid(second), centroid(third), offset))
        : null;
    }
  }
}

/** Value as drawn: `precision` decimals for lengths (diameter prefixed Ø), one decimal and ° for angles. */
export function formatDimensionValue(kind: DimensionEntity['dimensionKind'], value: number, precision: number): string {
  if (kind === 'angular') return `${value.toFixed(1)}°`;
  return `${kind === 'diameter' ? 'Ø' : ''}${value.toFixed(precision)}`;
}

/** Text of a dimension: `label` verbatim when set, else the formatted value followed by its `tolerance`. */
export function dimensionText(
  dimension: Pick<DimensionEntity, 'dimensionKind' | 'label' | 'precision' | 'tolerance'>,
  value: number,
  displayPrecision: number,
): string {
  if (dimension.label) return dimension.label;
  const text = formatDimensionValue(dimension.dimensionKind, value, dimension.precision ?? displayPrecision);
  return dimension.tolerance ? `${text} ${dimension.tolerance}` : text;
}
