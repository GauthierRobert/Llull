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
 * Must be rendered inside the -renderOrigin group in Viewport2D.tsx.
 */

import { useMemo, useEffect } from 'react';
import { Text } from '@react-three/drei';
import type * as THREE from 'three';
import type {
  DimensionEntity,
  CadDocument,
  CircleEntity,
  ArcEntity,
  EllipseEntity,
} from '@core/model/types';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';
import {
  DEFAULT_OFFSET,
  entityCentroid,
  formatValue,
  buildLinearGeometry,
  buildRadialGeometry,
  buildAngularGeometry,
} from './dimensionGeometry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SELECTION_COLOR = '#5b8dee';
const DIM_LINE_COLOR = '#333333';
const TEXT_HEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DimensionRenderer2DProps {
  entity: DimensionEntity;
  doc: CadDocument;
  selected: boolean;
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
  const dimColor = selected ? SELECTION_COLOR : color || DIM_LINE_COLOR;
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

    const value =
      dimensionKind === 'aligned' ? Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2) : Math.abs(bx - ax);

    const group = buildLinearGeometry(
      ax,
      ay,
      bx,
      by,
      offset,
      dimensionKind === 'aligned',
      dimColor,
    );

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
        font={TEXT_FONT_URL}
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
