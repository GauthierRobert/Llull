// Render branch for `kind:'nurbs_curve'`: the exact curve sampled per knot span, drawn as a line strip in both views; with the curvature comb on,
// the teeth (curvature x scale, away from the centre of curvature) and their envelope.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { NurbsCurveEntity } from '@core/model/types';
import { curveDisplayPoints } from '@core/geometry/nurbsCurve';
import { curveComb } from '@core/geometry/surfaceAnalysis/overlay';
import { useSurfaceOverlayStore } from '@ui/store/surfaceOverlayStore';
import { SELECTION_COLOR } from '../../viewportPalette';
import { positionsGeometry, rebaseToAnchor } from '../../lineGeometry';

const COMB_COLOR = '#d6562b';
const COMB_TEETH = 61;

/** The comb of `curve` as line objects (teeth as segments, envelope as a strip), or null when the comb is off or the curve is straight. */
function CurveComb({ curve, enabled }: { curve: NurbsCurveEntity['curve']; enabled: boolean }): React.ReactElement | null {
  const comb = useMemo(() => (enabled ? curveComb(curve, COMB_TEETH, null) : null), [curve, enabled]);
  const objects = useMemo(() => {
    if (comb === null || comb.teeth.length === 0 || comb.maxCurvature === 0) return null;
    const material = new THREE.LineBasicMaterial({ color: COMB_COLOR });
    const teeth = new THREE.LineSegments(positionsGeometry(comb.teeth), material);
    const envelope = new THREE.Line(positionsGeometry(comb.envelope), material);
    return { teeth, envelope, material };
  }, [comb]);
  useEffect(
    () => () => {
      objects?.teeth.geometry.dispose();
      objects?.envelope.geometry.dispose();
      objects?.material.dispose();
    },
    [objects],
  );
  if (objects === null) return null;
  return (
    <group name="curvature-comb">
      <primitive object={objects.teeth} />
      <primitive object={objects.envelope} />
    </group>
  );
}

export function NurbsCurveLine({
  entity: { curve, position, rotation, color, onFace },
  selected,
}: {
  entity: NurbsCurveEntity;
  selected: boolean;
}): React.ReactElement {
  const comb = useSurfaceOverlayStore((s) => s.comb);
  // `curve` is a new reference only when the curve changes (pure commands, L3).
  const rebased = useMemo(() => rebaseToAnchor(curveDisplayPoints(curve).flatMap(([x, y, z]) => [x, y, z])), [curve]);
  const geometry = useMemo(() => positionsGeometry(rebased.local), [rebased]);
  const onSurface = onFace !== undefined;
  // A curve lying on a face (wrap_to_face / project_to_face) is drawn after the solids and without writing depth, so it reads on the face instead of z-fighting with it.
  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color: selected ? SELECTION_COLOR : color, depthWrite: !onSurface }),
    [color, selected, onSurface],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  // Wrapper only: geometry and material are owned and disposed above.
  const object = useMemo(() => {
    const line = new THREE.Line(geometry, material);
    if (onSurface) line.renderOrder = 2;
    return line;
  }, [geometry, material, onSurface]);
  return (
    <group position={position} rotation={[rotation[0], rotation[1], rotation[2]]}>
      <primitive object={object} position={rebased.anchor} />
      <CurveComb curve={curve} enabled={comb} />
    </group>
  );
}
