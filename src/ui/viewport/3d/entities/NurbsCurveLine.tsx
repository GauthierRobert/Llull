// Render branch for `kind:'nurbs_curve'`: the exact curve sampled per knot span, drawn as a line strip in both views.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { NurbsCurveEntity } from '@core/model/types';
import { curveDisplayPoints } from '@core/geometry/nurbsCurve';
import { SELECTION_COLOR } from '../../viewportPalette';
import { positionsGeometry, rebaseToAnchor } from '../../lineGeometry';

export function NurbsCurveLine({
  entity: { curve, position, rotation, color },
  selected,
}: {
  entity: NurbsCurveEntity;
  selected: boolean;
}): React.ReactElement {
  // `curve` is a new reference only when the curve changes (pure commands, L3).
  const rebased = useMemo(() => rebaseToAnchor(curveDisplayPoints(curve).flatMap(([x, y, z]) => [x, y, z])), [curve]);
  const geometry = useMemo(() => positionsGeometry(rebased.local), [rebased]);
  const material = useMemo(() => new THREE.LineBasicMaterial({ color: selected ? SELECTION_COLOR : color }), [color, selected]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  // Wrapper only: geometry and material are owned and disposed above.
  const object = useMemo(() => new THREE.Line(geometry, material), [geometry, material]);
  return (
    <group position={position} rotation={[rotation[0], rotation[1], rotation[2]]}>
      <primitive object={object} position={rebased.anchor} />
    </group>
  );
}
