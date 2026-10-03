/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'ellipse'` entities.
 * Draws a closed ellipse outline in the XY plane using EllipseCurve geometry.
 * Geometry is memoized on the entity's center/radiusX/radiusY fields; disposed on unmount.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { EllipseEntity } from '@core/model/types';
import { PlacedLineObject } from './PlacedLineObject';

interface EllipseRendererProps {
  entity: EllipseEntity;
  selected: boolean;
}

const ELLIPSE_SEGMENTS = 64;

export function EllipseRenderer({
  entity,
  selected,
}: EllipseRendererProps): React.ReactElement | null {
  const { center, radiusX, radiusY, position, color } = entity;

  const lineObject = useMemo(() => {
    const curve = new THREE.EllipseCurve(
      center[0],
      center[1],
      radiusX,
      radiusY,
      0,
      Math.PI * 2,
      false,
      0,
    );
    // getPoints returns N+1 pts; close the loop by including the closing point.
    const pts = curve.getPoints(ELLIPSE_SEGMENTS);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], radiusX, radiusY, color, selected]);

  return <PlacedLineObject object={lineObject} position={position} />;
}
