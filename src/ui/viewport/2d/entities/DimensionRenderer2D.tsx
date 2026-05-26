/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'dimension'` entities in the 2D orthographic drafting viewport.
 *
 * Supports four dimension kinds:
 *  - linear  : horizontal distance between two referenced point/line entities.
 *  - aligned : full 2D distance, dimension line parallel to the segment between the two refs.
 *  - radial  : radius of a circle, arc, or ellipse (radiusX for ellipse).
 *  - angular : angle at the vertex of two lines/points, drawn as an arc.
 *
 * Geometry: three.js primitives (BufferGeometry + Line). Memoized keyed on geometry deps;
 * disposed in useEffect cleanup (R9). Value text via drei <Text> (no disposal needed).
 *
 * Graceful: missing or wrong-kind referenced entities → renders nothing without crashing.
 * Value = entity.label if set, else computed. Precision = entity.precision if set, else
 * document displayPrecision.
 *
 * Must be rendered inside the -renderOrigin group in Viewport2D.tsx (U4 convention).
 */

import { useMemo, useEffect } from 'react';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import type {
  DimensionEntity,
  Entity,
  CadDocument,
  LineEntity,
  CircleEntity,
  ArcEntity,
  EllipseEntity,
} from '@core/model/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OFFSET = 5;
const ARROWHEAD_SIZE = 0.3;
const ANGULAR_ARC_SEGMENTS = 32;
const SELECTION_COLOR = '#5b8dee';
const DIM_LINE_COLOR = '#333333';
const TEXT_HEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DimensionRenderer2DProps {
  entity: DimensionEntity;
  doc: CadDocument;
  selected: boolean;
}

// ---------------------------------------------------------------------------
// Pure geometry helpers (no React, no side effects)
// ---------------------------------------------------------------------------

/** Get the world-space centroid of a line or point entity as [x, y]. */
function entityCentroid(e: Entity): [number, number] | null {
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
function arrowheadPoints(
  tipX: number,
  tipY: number,
  dx: number,
  dy: number,
): [number, number, number, number, number, number, number, number, number, number, number, number] {
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
    tipX, tipY, 0,
    tipX - nx * s + px * s * 0.5, tipY - ny * s + py * s * 0.5, 0,
    tipX, tipY, 0,
    tipX - nx * s - px * s * 0.5, tipY - ny * s - py * s * 0.5, 0,
  ];
}

/** Format a number with a given number of decimal places. */
function formatValue(value: number, precision: number): string {
  return value.toFixed(precision);
}

// ---------------------------------------------------------------------------
// Sub-renderers (each returns THREE.Object3D groups or null)
// ---------------------------------------------------------------------------

/** Build the geometry for a linear or aligned dimension. */
function buildLinearGeometry(
  ax: number, ay: number,
  bx: number, by: number,
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
  const extVerts = new Float32Array([
    ax, ay, 0, dimAx, dimAy, 0,
    bx, by, 0, dimBx, dimBy, 0,
  ]);
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
function buildRadialGeometry(
  cx: number, cy: number,
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
function buildAngularGeometry(
  vx: number, vy: number,
  ax: number, ay: number,
  bx: number, by: number,
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
  const curve = new THREE.EllipseCurve(vx, vy, arcRadius, arcRadius, startAngle, endAngle, false, 0);
  const pts = curve.getPoints(ANGULAR_ARC_SEGMENTS);

  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color });

  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  group.add(new THREE.Line(geo, mat));

  // Extension lines from vertex to arms at arcRadius distance.
  const extVerts = new Float32Array([
    vx, vy, 0,
    vx + Math.cos(startAngle) * arcRadius, vy + Math.sin(startAngle) * arcRadius, 0,
    vx, vy, 0,
    vx + Math.cos(endAngle) * arcRadius, vy + Math.sin(endAngle) * arcRadius, 0,
  ]);
  const extGeo = new THREE.BufferGeometry();
  extGeo.setAttribute('position', new THREE.BufferAttribute(extVerts, 3));
  group.add(new THREE.LineSegments(extGeo, mat));

  return group;
}

// ---------------------------------------------------------------------------
// Geometry cleanup
// ---------------------------------------------------------------------------

function disposeGroup(group: THREE.Group | null): void {
  if (!group) return;
  group.traverse((child) => {
    if ((child as THREE.Line).isLine || (child as THREE.LineSegments).isLineSegments) {
      const line = child as THREE.Line;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DimensionRenderer2D({
  entity,
  doc,
  selected,
}: DimensionRenderer2DProps): React.ReactElement | null {
  const { dimensionKind, entityIds, offset: rawOffset, precision, label, color, position } = entity;
  const offset = rawOffset ?? DEFAULT_OFFSET;
  const dimColor = selected ? SELECTION_COLOR : (color || DIM_LINE_COLOR);
  const effectivePrecision = precision ?? doc.displayPrecision;

  // ---------------------------------------------------------------------------
  // Resolve referenced entities
  // ---------------------------------------------------------------------------
  const refs = useMemo(() => {
    return entityIds.map((id) => doc.entities[id] ?? null);
  }, [entityIds, doc.entities]);

  // ---------------------------------------------------------------------------
  // Linear / Aligned
  // ---------------------------------------------------------------------------
  const linearData = useMemo(() => {
    if (dimensionKind !== 'linear' && dimensionKind !== 'aligned') return null;
    if (refs.length < 2) return null;
    const refA = refs[0];
    const refB = refs[1];
    if (!refA || !refB) return null;
    if (refA.kind !== 'line' && refA.kind !== 'point') return null;
    if (refB.kind !== 'line' && refB.kind !== 'point') return null;

    const ca = entityCentroid(refA);
    const cb = entityCentroid(refB);
    if (!ca || !cb) return null;

    const [ax, ay] = ca;
    const [bx, by] = cb;

    const value = dimensionKind === 'aligned'
      ? Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2)
      : Math.abs(bx - ax);

    const group = buildLinearGeometry(ax, ay, bx, by, offset, dimensionKind === 'aligned', dimColor);

    // Midpoint of dimension line for text placement.
    let textX: number, textY: number;
    if (dimensionKind === 'aligned') {
      const dx = bx - ax;
      const dy = by - ay;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      const perpX = segLen > 1e-9 ? -dy / segLen : 0;
      const perpY = segLen > 1e-9 ? dx / segLen : 1;
      textX = (ax + bx) / 2 + perpX * offset;
      textY = (ay + by) / 2 + perpY * offset;
    } else {
      const topY = Math.max(ay, by);
      textX = (ax + bx) / 2;
      textY = topY + offset;
    }

    return { group, value, textX, textY };
  }, [dimensionKind, refs, offset, dimColor]);

  useEffect(() => {
    return () => disposeGroup(linearData?.group ?? null);
  }, [linearData]);

  // ---------------------------------------------------------------------------
  // Radial
  // @invariant entity.offset is interpreted as an angle in radians (0, 2π) here,
  //            not as a perpendicular distance — unlike the linear/aligned branches.
  // ---------------------------------------------------------------------------
  const radialData = useMemo(() => {
    if (dimensionKind !== 'radial') return null;
    if (refs.length < 1) return null;
    const ref = refs[0];
    if (!ref) return null;
    if (ref.kind !== 'circle' && ref.kind !== 'arc' && ref.kind !== 'ellipse') return null;

    const [px, py] = ref.position;
    let cx: number, cy: number, radius: number;

    if (ref.kind === 'circle') {
      const ce = ref as CircleEntity;
      cx = px + ce.center[0];
      cy = py + ce.center[1];
      radius = ce.radius;
    } else if (ref.kind === 'arc') {
      const ae = ref as ArcEntity;
      cx = px + ae.center[0];
      cy = py + ae.center[1];
      radius = ae.radius;
    } else {
      // ellipse — use radiusX as documented
      const ee = ref as EllipseEntity;
      cx = px + ee.center[0];
      cy = py + ee.center[1];
      // For ellipse dimensions: radiusX is used as the representative radius value.
      radius = ee.radiusX;
    }

    const angle = Math.PI / 4; // 45° default direction
    const textX = cx + Math.cos(angle) * radius * 1.15;
    const textY = cy + Math.sin(angle) * radius * 1.15;

    const group = buildRadialGeometry(cx, cy, radius, offset, dimColor);
    return { group, value: radius, textX, textY };
  }, [dimensionKind, refs, offset, dimColor]);

  useEffect(() => {
    return () => disposeGroup(radialData?.group ?? null);
  }, [radialData]);

  // ---------------------------------------------------------------------------
  // Angular
  // ---------------------------------------------------------------------------
  const angularData = useMemo(() => {
    if (dimensionKind !== 'angular') return null;
    if (refs.length < 3) return null;
    const [vertRef, armARef, armBRef] = refs;
    if (!vertRef || !armARef || !armBRef) return null;
    if (vertRef.kind !== 'point' && vertRef.kind !== 'line') return null;
    if (armARef.kind !== 'point' && armARef.kind !== 'line') return null;
    if (armBRef.kind !== 'point' && armBRef.kind !== 'line') return null;

    const vc = entityCentroid(vertRef);
    const ac = entityCentroid(armARef);
    const bc = entityCentroid(armBRef);
    if (!vc || !ac || !bc) return null;

    const [vx, vy] = vc;
    const [ax, ay] = ac;
    const [bx, by] = bc;

    // Compute angle at vertex between arms.
    const angleA = Math.atan2(ay - vy, ax - vx);
    const angleB = Math.atan2(by - vy, bx - vx);
    let sweep = angleB - angleA;
    if (sweep < 0) sweep += Math.PI * 2;
    if (sweep > Math.PI) sweep = Math.PI * 2 - sweep;
    const angleDeg = (sweep * 180) / Math.PI;

    const arcRadius = offset > 0 ? offset : DEFAULT_OFFSET;
    // Text at midpoint of arc.
    let startAngle = angleA;
    let endAngle = angleB;
    let s2 = endAngle - startAngle;
    if (s2 < 0) s2 += Math.PI * 2;
    if (s2 > Math.PI) {
      startAngle = angleB;
      endAngle = angleA;
      s2 = Math.PI * 2 - s2;
    }
    const midAngle = startAngle + s2 / 2;
    const textX = vx + Math.cos(midAngle) * arcRadius * 1.4;
    const textY = vy + Math.sin(midAngle) * arcRadius * 1.4;

    const group = buildAngularGeometry(vx, vy, ax, ay, bx, by, offset, dimColor);
    return { group, value: angleDeg, textX, textY };
  }, [dimensionKind, refs, offset, dimColor]);

  useEffect(() => {
    return () => disposeGroup(angularData?.group ?? null);
  }, [angularData]);

  // ---------------------------------------------------------------------------
  // Compute the display text
  // ---------------------------------------------------------------------------
  const data = linearData ?? radialData ?? angularData;
  if (!data) return null;

  const displayText = label
    ? label
    : dimensionKind === 'angular'
    ? `${formatValue(data.value, 1)}°`
    : formatValue(data.value, effectivePrecision);

  const [posX, posY, posZ] = position;

  return (
    <group position={[posX, posY, posZ]}>
      {data.group && <primitive object={data.group} />}
      <Text
        position={[data.textX, data.textY, 0.01]}
        fontSize={TEXT_HEIGHT}
        color={dimColor}
        anchorX="center"
        anchorY="middle"
      >
        {displayText}
      </Text>
    </group>
  );
}
