// Shared drawing of a light / camera entity: line glyph (screen-constant size unless real-size), an invisible pick volume, and the
// selection click. Sits at the entity's position and rotation; the actual three.js light (LightObject) is a child.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { BaseEntity } from '@core/model/types';
import { selectOnClick } from '@ui/viewport/selectClick';
import { SELECTION_COLOR, useViewportPalette } from '../../viewportPalette';
import { useStore } from '@ui/store';
import { environmentLook } from '../appearance/environmentPlan';
import { glyphInk } from './glyphInk';
import { POINT_MARKER_HALF_PIXELS, worldUnitsForPixels } from '../../2d/pointMarkerScale';

/** Screen size of a unit-size glyph (its extent is about 2 units): 3x the point marker. */
const GLYPH_PIXELS = POINT_MARKER_HALF_PIXELS * 10;
const RENDER_ORDER = 997;
const NO_EDGES = { noEdges: true };
const worldPosition = new THREE.Vector3();

interface SceneObjectGlyphProps {
  entity: Pick<BaseEntity, 'id' | 'position' | 'rotation'>;
  /** Flat xyz line pairs in the entity frame. */
  positions: readonly number[];
  screenScaled: boolean;
  color: string;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Pick volume: a sphere of this radius (unit glyph size) at depth `pickZ` along the local axis, or the real-size `pickPlane`. */
  pickZ?: number;
  pickPlane?: { readonly width: number; readonly height: number };
  children?: React.ReactNode;
}

export function SceneObjectGlyph({
  entity,
  positions,
  screenScaled,
  color,
  selected,
  onSelect,
  pickZ = 0,
  pickPlane,
  children,
}: SceneObjectGlyphProps): React.ReactElement {
  const scaleRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => {
    const created = new THREE.BufferGeometry();
    created.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));
    return created;
  }, [positions]);
  const environment = useStore((s) => s.document.appearance?.environment);
  const background = environmentLook(environment, useViewportPalette().background).background;
  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({ color: selected ? SELECTION_COLOR : glyphInk(color, background), depthTest: false, transparent: true }),
    [color, selected, background],
  );
  const pickMaterial = useMemo(() => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => pickMaterial.dispose(), [pickMaterial]);
  const lines = useMemo(() => {
    const object = new THREE.LineSegments(geometry, material);
    object.renderOrder = RENDER_ORDER;
    object.userData = NO_EDGES;
    // Picking goes through the pick volume, never the thin lines.
    object.raycast = (): void => undefined;
    return object;
  }, [geometry, material]);

  useFrame(({ camera, size }) => {
    const group = scaleRef.current;
    if (!group || !screenScaled) return;
    const scale = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? worldUnitsForPixels(GLYPH_PIXELS, { kind: 'orthographic', zoom: (camera as THREE.OrthographicCamera).zoom })
      : worldUnitsForPixels(GLYPH_PIXELS, {
          kind: 'perspective',
          fovDegrees: (camera as THREE.PerspectiveCamera).fov,
          distance: camera.position.distanceTo(group.getWorldPosition(worldPosition)),
          viewportHeight: size.height,
        });
    if (group.scale.x !== scale) group.scale.setScalar(scale);
  });

  return (
    <group name={entity.id} position={entity.position} rotation={entity.rotation} userData={{ entityId: entity.id }}>
      <group ref={scaleRef}>
        <primitive object={lines} />
        <mesh position={[0, 0, -pickZ]} material={pickMaterial} userData={NO_EDGES} onClick={selectOnClick(entity.id, onSelect)}>
          {pickPlane === undefined ? <sphereGeometry args={[0.55, 8, 6]} /> : <planeGeometry args={[pickPlane.width, pickPlane.height]} />}
        </mesh>
      </group>
      {children}
    </group>
  );
}
