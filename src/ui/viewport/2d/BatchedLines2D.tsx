/**
 * @layer ui/viewport/2d
 *
 * Renders every unselected, visible `line` entity as a single LineSegments draw call
 * (selected lines keep the per-entity path so they get the selection highlight). Geometry and
 * material are rebuilt when the set of line entities changes and disposed with the component (R9).
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { LineEntity } from '@core/model/types';
import { buildLineBatch } from './batchLines';

interface BatchedLines2DProps {
  lines: ReadonlyArray<LineEntity>;
}

export function BatchedLines2D({ lines }: BatchedLines2DProps): React.ReactElement | null {
  const batch = useMemo(() => {
    const built = buildLineBatch(lines);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(Float32Array.from(built.positions), 3),
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(built.colors), 3));
    return { geometry, anchor: built.anchor };
  }, [lines]);
  const material = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true }), []);
  useEffect(() => () => batch.geometry.dispose(), [batch]);
  useEffect(() => () => material.dispose(), [material]);

  if (lines.length === 0) return null;
  return <lineSegments geometry={batch.geometry} material={material} position={batch.anchor} />;
}
