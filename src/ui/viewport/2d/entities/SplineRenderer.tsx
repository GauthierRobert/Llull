/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'spline'` entities.
 * Tessellates a centripetal Catmull-Rom spline through the entity's `points`
 * using THREE.CatmullRomCurve3 with curveType:'centripetal'.
 * Geometry is memoized on the entity's points/closed fields; disposed on unmount.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { SplineEntity } from '@core/model/types';

interface SplineRendererProps {
  entity: SplineEntity;
  selected: boolean;
}

const SPLINE_SEGMENTS_PER_POINT = 16;

export function SplineRenderer({ entity, selected }: SplineRendererProps): React.ReactElement | null {
  const { points, closed, position, color } = entity;

  const lineObject = useMemo(() => {
    if (points.length < 2) return null;

    // Lift 2D through-points to 3D (z=0) for CatmullRomCurve3.
    const v3Points = points.map((p) => new THREE.Vector3(p[0], p[1], 0));

    const curve = new THREE.CatmullRomCurve3(v3Points, closed, 'centripetal');
    const totalSegments = points.length * SPLINE_SEGMENTS_PER_POINT;
    const tessellated = curve.getPoints(totalSegments);

    const geo = new THREE.BufferGeometry().setFromPoints(tessellated);
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
    // `points` is a new reference only when the spline actually changes (pure commands, L3).
  }, [points, closed, color, selected]);

  useEffect(() => {
    return () => {
      lineObject?.geometry.dispose();
      (lineObject?.material as THREE.Material | undefined)?.dispose();
    };
  }, [lineObject]);

  if (!lineObject) return null;

  lineObject.position.set(position[0], position[1], position[2]);

  return <primitive object={lineObject} />;
}
