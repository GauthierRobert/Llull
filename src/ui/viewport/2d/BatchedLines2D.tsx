// Unselected visible `line` entities as ONE LineSegments (selected ones keep their own path for the highlight).

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { LineEntity } from '@core/model/types';
import { positionsGeometry } from '../lineGeometry';
import { buildLineBatch } from './batchLines';

export function BatchedLines2D({ lines }: { lines: ReadonlyArray<LineEntity> }): React.ReactElement | null {
  const batch = useMemo(() => {
    const built = buildLineBatch(lines);
    const geometry = positionsGeometry(built.positions);
    geometry.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(built.colors), 3));
    return { geometry, anchor: built.anchor };
  }, [lines]);
  const material = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true }), []);
  useEffect(() => () => batch.geometry.dispose(), [batch]);
  useEffect(() => () => material.dispose(), [material]);

  if (lines.length === 0) return null;
  return <lineSegments geometry={batch.geometry} material={material} position={batch.anchor} />;
}
