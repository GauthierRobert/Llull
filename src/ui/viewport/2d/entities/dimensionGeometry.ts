/** @layer ui/viewport/2d — pure three.js geometry builders for 2D dimension entities. */

import * as THREE from 'three';
import type { Entity, LineEntity } from '@core/model/types';

const ARROWHEAD_SIZE = 0.3;
const ANGULAR_ARC_SEGMENTS = 32;
export const DEFAULT_OFFSET = 5;

/** Get the world-space centroid of a line or point entity as [x, y]. */
export function entityCentroid(e: Entity): [number, number] | null {
  const [px, py] = e.position;
  if (e.kind === 'point') {
    return [px, py];
  }
  if (e.kind === 'line') {
    const le = e as LineEntity;
    return [px + (le.start[0] + le.end[0]) / 2, py + (le.start[1] + le.end[1]) / 2];
  }
  // Fallback: use entity position for unknown centroid-able kinds.
  return [px, py];
}

/** Build arrowhead vertices at tip pointing toward direction (dx, dy). Returns 6 floats (2 pts). */
export function arrowheadPoints(
  tipX: number,
  tipY: number,
  dx: number,
  dy: number,
): [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) {
    return [tipX, tipY, 0, tipX, tipY, 0, tipX, tipY, 0, tipX, tipY, 0];
  }
  const nx = dx / len;
  const ny = dy / len;
  // Perpendicular
  const px = -ny;
  const py = nx;
  const s = ARROWHEAD_SIZE;
  // Two lines from tip: one to each wing of the arrowhead.
  return [
    tipX,
    tipY,
    0,
    tipX - nx * s + px * s * 0.5,
    tipY - ny * s + py * s * 0.5,
    0,
    tipX,
    tipY,
    0,
    tipX - nx * s - px * s * 0.5,
    tipY - ny * s - py * s * 0.5,
    0,
  ];
}

/** Format a number with a given number of decimal places. */
export function formatValue(value: number, precision: number): string {
  return value.toFixed(precision);
}

/** Build the geometry for a linear or aligned dimension. */
export function buildLinearGeometry(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  offset: number,
  aligned: boolean,
  color: string,
): THREE.Group | null {
  // Direction vector from A to B.
  const dx = bx - ax;
  const dy = by - ay;
  const segLen = Math.sqrt(dx * dx + dy * dy);
  if (segLen < 1e-9) return null;

  let dimAx: number, dimAy: number, dimBx: number, dimBy: number;
  let perpX: number, perpY: number;

  if (aligned) {
    // Dimension line is parallel to A→B, offset perpendicularly.
    perpX = -dy / segLen;
    perpY = dx / segLen;
    dimAx = ax + perpX * offset;
    dimAy = ay + perpY * offset;
    dimBx = bx + perpX * offset;
    dimBy = by + perpY * offset;
  } else {
    // Linear: horizontal distance; dimension line is horizontal, offset vertically above the higher ref.
    const topY = Math.max(ay, by);
    perpX = 0;
    perpY = 1;
    dimAx = ax;
    dimAy = topY + offset;
    dimBx = bx;
    dimBy = topY + offset;
  }

  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color });

  // Extension lines: from each reference point to the dimension line.
  const extVerts = new Float32Array([ax, ay, 0, dimAx, dimAy, 0, bx, by, 0, dimBx, dimBy, 0]);
  const extGeo = new THREE.BufferGeometry();
  extGeo.setAttribute('position', new THREE.BufferAttribute(extVerts, 3));
  group.add(new THREE.LineSegments(extGeo, mat));

  // Dimension line from dimA to dimB.
  const dimLineVerts = new Float32Array([dimAx, dimAy, 0, dimBx, dimBy, 0]);
  const dimLineGeo = new THREE.BufferGeometry();
  dimLineGeo.setAttribute('position', new THREE.BufferAttribute(dimLineVerts, 3));
  group.add(new THREE.Line(dimLineGeo, mat));

  // Arrowheads: at dimA pointing toward dimB, at dimB pointing toward dimA.
  const dirABx = dimBx - dimAx;
  const dirABy = dimBy - dimAy;
  const arrowA = arrowheadPoints(dimAx, dimAy, -dirABx, -dirABy);
  const arrowB = arrowheadPoints(dimBx, dimBy, dirABx, dirABy);
  const arrowVerts = new Float32Array([...arrowA, ...arrowB]);
  const arrowGeo = new THREE.BufferGeometry();
  arrowGeo.setAttribute('position', new THREE.BufferAttribute(arrowVerts, 3));
  group.add(new THREE.LineSegments(arrowGeo, mat));

  return group;
}

/** Build the geometry for a radial dimension. */
export function buildRadialGeometry(
  cx: number,
  cy: number,
  radius: number,
  offset: number,
  color: string,
): THREE.Group {
  // Direction at 45 degrees by default (entity offset interpreted as angle in radians if > 2π, else use as angle directly)
  // We treat offset > 0 as the angle (radians) for the radial line direction.
  // Default: 45 degrees (π/4).
  const angle = offset > 0 && offset < Math.PI * 2 ? offset : Math.PI / 4;
  const ex = cx + Math.cos(angle) * radius;
  const ey = cy + Math.sin(angle) * radius;

  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color });

  // Line from center to point on curve.
  const verts = new Float32Array([cx, cy, 0, ex, ey, 0]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  group.add(new THREE.Line(geo, mat));

  // Arrowhead at end of radius line (pointing outward from center).
  const arrowVerts = new Float32Array(arrowheadPoints(ex, ey, ex - cx, ey - cy));
  const arrowGeo = new THREE.BufferGeometry();
  arrowGeo.setAttribute('position', new THREE.BufferAttribute(arrowVerts, 3));
  group.add(new THREE.LineSegments(arrowGeo, mat));

  return group;
}

/** Build the geometry for an angular dimension arc. */
export function buildAngularGeometry(
  vx: number,
  vy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  offset: number,
  color: string,
): THREE.Group | null {
  // Compute angle from vertex to each arm point.
  const angleA = Math.atan2(ay - vy, ax - vx);
  const angleB = Math.atan2(by - vy, bx - vx);
  let startAngle = angleA;
  let endAngle = angleB;

  // Normalize so arc sweeps the smaller angle.
  let sweep = endAngle - startAngle;
  if (sweep < 0) sweep += Math.PI * 2;
  if (sweep > Math.PI) {
    // Swap to get the minor arc.
    startAngle = angleB;
    endAngle = angleA;
  }

  const arcRadius = offset > 0 ? offset : DEFAULT_OFFSET;
  const curve = new THREE.EllipseCurve(
    vx,
    vy,
    arcRadius,
    arcRadius,
    startAngle,
    endAngle,
    false,
    0,
  );
  const pts = curve.getPoints(ANGULAR_ARC_SEGMENTS);

  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color });

  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  group.add(new THREE.Line(geo, mat));

  // Extension lines from vertex to arms at arcRadius distance.
  const extVerts = new Float32Array([
    vx,
    vy,
    0,
    vx + Math.cos(startAngle) * arcRadius,
    vy + Math.sin(startAngle) * arcRadius,
    0,
    vx,
    vy,
    0,
    vx + Math.cos(endAngle) * arcRadius,
    vy + Math.sin(endAngle) * arcRadius,
    0,
  ]);
  const extGeo = new THREE.BufferGeometry();
  extGeo.setAttribute('position', new THREE.BufferAttribute(extVerts, 3));
  group.add(new THREE.LineSegments(extGeo, mat));

  return group;
}
