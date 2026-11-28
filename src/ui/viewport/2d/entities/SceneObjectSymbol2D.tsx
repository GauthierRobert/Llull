// Top-view symbol of a light / camera in the 2D draft view: a small outline (ring + rays for a light, a box for a camera, a tick along the
// aim), constant on screen like the `point` marker. Drawn only; picking them is done in the 3D view or the objects list.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import type { CameraEntity, LightEntity } from '@core/model/types';
import { planSymbol } from '../../3d/lights/sceneObjectGlyphs';
import { POINT_MARKER_HALF_PIXELS, worldUnitsForPixels } from '../pointMarkerScale';
import { ShapeLine } from './ShapeLine';

const ORIGIN: [number, number, number] = [0, 0, 0];
/** Unit symbol is about 1.7 across: this many half-arms of a point marker. */
const SYMBOL_PIXELS = POINT_MARKER_HALF_PIXELS * 3;

export function SceneObjectSymbol2D({ entity, selected }: { entity: LightEntity | CameraEntity; selected: boolean }): React.ReactElement {
  const scaleRef = useRef<THREE.Group>(null);
  const lightType = entity.kind === 'light' ? entity.lightType : undefined;
  const { rotation } = entity;
  const positions = useMemo(() => planSymbol({ kind: entity.kind, rotation }, lightType), [entity.kind, rotation, lightType]);
  useFrame(({ camera }) => {
    const group = scaleRef.current;
    if (!group) return;
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    const scale = worldUnitsForPixels(SYMBOL_PIXELS, { kind: 'orthographic', zoom: typeof zoom === 'number' ? zoom : 1 });
    if (group.scale.x !== scale) group.scale.setScalar(scale);
  });
  const color = entity.kind === 'light' ? entity.lightColor : entity.color;
  return (
    <group ref={scaleRef} position={entity.position}>
      <ShapeLine positions={positions} segments linewidth={2} position={ORIGIN} color={color} selected={selected} />
    </group>
  );
}
