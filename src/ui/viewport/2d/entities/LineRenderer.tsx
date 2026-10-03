/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'line'` entities.
 * Draws a 2-point line segment in the XY plane using LineSegments geometry.
 * Geometry is memoized on the entity's start/end fields; disposed on unmount.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { LineEntity } from '@core/model/types';
import { PlacedLineObject } from './PlacedLineObject';

interface LineRendererProps {
  entity: LineEntity;
  selected: boolean;
}

export function LineRenderer({ entity, selected }: LineRendererProps): React.ReactElement | null {
  const { start, end, position, color } = entity;

  const segmentsObject = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const vertices = new Float32Array([start[0], start[1], 0, end[0], end[1], 0]);
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.LineSegments(geo, mat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start[0], start[1], end[0], end[1], color, selected]);

  return <PlacedLineObject object={segmentsObject} position={position} />;
}
