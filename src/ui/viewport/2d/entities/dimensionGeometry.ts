/**
 * @layer ui/viewport/2d
 * Pure drawing of 2D dimension entities: the measured value, the label anchor and the
 * LineSegments (dimension / extension lines, arrowheads) for each dimension kind.
 */

import * as THREE from 'three';
import type {
  ArcEntity,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  Entity,
  LineEntity,
  PointEntity,
  Vec2,
} from '@core/model/types';
import { anchoredGeometry, chainSegments } from '../../lineGeometry';

const ARROWHEAD_SIZE = 0.3;
const ANGULAR_ARC_SEGMENTS = 32;
const EPSILON = 1e-9;
export const DEFAULT_OFFSET = 5;

interface DimensionDrawing {
  /** Measured value: a length, a radius, or an angle in degrees. */
  value: number;
  /** Label anchor in the entity's XY plane. */
  textX: number;
  textY: number;
  /** Null when the measured geometry is degenerate (only the label is drawn). */
  lines: THREE.LineSegments | null;
}

type Locatable = PointEntity | LineEntity;
type Radial = CircleEntity | ArcEntity | EllipseEntity;

function isLocatable(entity: Entity | null | undefined): entity is Locatable {
  return entity?.kind === 'point' || entity?.kind === 'line';
}

function isRadial(entity: Entity | null | undefined): entity is Radial {
  return entity?.kind === 'circle' || entity?.kind === 'arc' || entity?.kind === 'ellipse';
}

/** World-space centroid of a point or line entity. */
function centroid(entity: Locatable): Vec2 {
  const [px, py] = entity.position;
  if (entity.kind === 'point') return [px, py];
  return [px + (entity.start[0] + entity.end[0]) / 2, py + (entity.start[1] + entity.end[1]) / 2];
}

/** The two wing segments of an arrowhead with its tip at `tip`, pointing along (dx, dy). */
function arrowhead(tip: Vec2, dx: number, dy: number): Vec2[] {
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < EPSILON) return [tip, tip, tip, tip];
  const nx = dx / length;
  const ny = dy / length;
  const px = -ny;
  const py = nx;
  const s = ARROWHEAD_SIZE;
  return [
    tip,
    [tip[0] - nx * s + px * s * 0.5, tip[1] - ny * s + py * s * 0.5],
    tip,
    [tip[0] - nx * s - px * s * 0.5, tip[1] - ny * s - py * s * 0.5],
  ];
}

function drawLines(vertices: ReadonlyArray<Vec2>, color: string): THREE.LineSegments {
  const { geometry, anchor } = anchoredGeometry(vertices);
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
  lines.position.set(...anchor);
  return lines;
}

/** Linear: horizontal distance, line above the higher ref. Aligned: true distance, line parallel. */
function linearDrawing(
  a: Vec2,
  b: Vec2,
  offset: number,
  aligned: boolean,
  color: string,
): DimensionDrawing {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  const degenerate = length < EPSILON;
  const perp: Vec2 = degenerate ? [0, 1] : [-dy / length, dx / length];
  const topY = Math.max(a[1], b[1]);
  const dimA: Vec2 = aligned
    ? [a[0] + perp[0] * offset, a[1] + perp[1] * offset]
    : [a[0], topY + offset];
  const dimB: Vec2 = aligned
    ? [b[0] + perp[0] * offset, b[1] + perp[1] * offset]
    : [b[0], topY + offset];
  const dirX = dimB[0] - dimA[0];
  const dirY = dimB[1] - dimA[1];
  return {
    value: aligned ? length : Math.abs(dx),
    textX: (a[0] + b[0]) / 2 + (aligned ? perp[0] * offset : 0),
    textY: aligned ? (a[1] + b[1]) / 2 + perp[1] * offset : topY + offset,
    lines: degenerate
      ? null
      : drawLines(
          [
            a,
            dimA,
            b,
            dimB,
            dimA,
            dimB,
            ...arrowhead(dimA, -dirX, -dirY),
            ...arrowhead(dimB, dirX, dirY),
          ],
          color,
        ),
  };
}

/** Radial: radius line from the centre to the rim (radiusX for an ellipse) with an arrowhead. */
function radialDrawing(ref: Radial, offset: number, color: string): DimensionDrawing {
  const [cx, cy] = [ref.position[0] + ref.center[0], ref.position[1] + ref.center[1]];
  const radius = ref.kind === 'ellipse' ? ref.radiusX : ref.radius;
  // The offset doubles as the radius-line angle (radians) when it is a plausible angle.
  const angle = offset > 0 && offset < Math.PI * 2 ? offset : Math.PI / 4;
  const rim: Vec2 = [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  return {
    value: radius,
    textX: cx + Math.cos(Math.PI / 4) * radius * 1.15,
    textY: cy + Math.sin(Math.PI / 4) * radius * 1.15,
    lines: drawLines([[cx, cy], rim, ...arrowhead(rim, rim[0] - cx, rim[1] - cy)], color),
  };
}

/** Angular: minor arc between the two arms, with extension lines from the vertex. */
function angularDrawing(
  vertex: Vec2,
  armA: Vec2,
  armB: Vec2,
  offset: number,
  color: string,
): DimensionDrawing {
  const [vx, vy] = vertex;
  const angleA = Math.atan2(armA[1] - vy, armA[0] - vx);
  const angleB = Math.atan2(armB[1] - vy, armB[0] - vx);
  let sweep = angleB - angleA;
  if (sweep < 0) sweep += Math.PI * 2;
  const swapped = sweep > Math.PI;
  const startAngle = swapped ? angleB : angleA;
  const endAngle = swapped ? angleA : angleB;
  const minorSweep = swapped ? Math.PI * 2 - sweep : sweep;

  const arcRadius = offset > 0 ? offset : DEFAULT_OFFSET;
  const arc = new THREE.EllipseCurve(vx, vy, arcRadius, arcRadius, startAngle, endAngle, false, 0)
    .getPoints(ANGULAR_ARC_SEGMENTS)
    .map(({ x, y }): Vec2 => [x, y]);
  const arcEnd = (angle: number): Vec2 => [
    vx + Math.cos(angle) * arcRadius,
    vy + Math.sin(angle) * arcRadius,
  ];
  const midAngle = startAngle + minorSweep / 2;
  return {
    value: (minorSweep * 180) / Math.PI,
    textX: vx + Math.cos(midAngle) * arcRadius * 1.4,
    textY: vy + Math.sin(midAngle) * arcRadius * 1.4,
    lines: drawLines(
      [...chainSegments(arc), vertex, arcEnd(startAngle), vertex, arcEnd(endAngle)],
      color,
    ),
  };
}

/**
 * Drawing of one dimension entity from the entities it references (null entries = dangling).
 * @failure missing or wrong-kind references -> null (nothing is drawn)
 */
export function dimensionDrawing(
  kind: DimensionEntity['dimensionKind'],
  refs: ReadonlyArray<Entity | null | undefined>,
  offset: number,
  color: string,
): DimensionDrawing | null {
  const [first, second, third] = refs;
  switch (kind) {
    case 'linear':
    case 'aligned':
      return isLocatable(first) && isLocatable(second)
        ? linearDrawing(centroid(first), centroid(second), offset, kind === 'aligned', color)
        : null;
    case 'radial':
      return isRadial(first) ? radialDrawing(first, offset, color) : null;
    case 'angular':
      return isLocatable(first) && isLocatable(second) && isLocatable(third)
        ? angularDrawing(centroid(first), centroid(second), centroid(third), offset, color)
        : null;
  }
}
