// Line segments of the review overlays (sweep frames, deformation): one geometry, two passes.

import React, { useMemo } from 'react';
import * as THREE from 'three';
import { positionsGeometry } from '../../lineGeometry';
import { useDisposable } from '../../useDisposable';

const RENDER_ORDER = 997;
const HIDDEN_OPACITY = 0.25;

/** Lines drawn depth-tested, plus a faint second pass without depth so the parts behind the solid stay readable. */
export function Segments({ positions, color }: { positions: Float32Array; color: string }): React.ReactElement | null {
  const geometry = useDisposable(() => positionsGeometry(positions), [positions]);
  const front = useDisposable(() => new THREE.LineBasicMaterial({ color }), [color]);
  const behind = useDisposable(
    () => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: HIDDEN_OPACITY }),
    [color],
  );
  const objects = useMemo(() => {
    const make = (material: THREE.LineBasicMaterial, order: number): THREE.LineSegments => {
      const lines = new THREE.LineSegments(geometry, material);
      lines.renderOrder = order;
      lines.frustumCulled = false;
      return lines;
    };
    return [make(behind, RENDER_ORDER), make(front, RENDER_ORDER + 1)];
  }, [geometry, front, behind]);
  if (positions.length === 0) return null;
  return (
    <>
      {objects.map((object) => (
        <primitive key={object.id} object={object} />
      ))}
    </>
  );
}
