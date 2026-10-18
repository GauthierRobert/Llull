// Beacons of the highlighted panel item (useFocusStore): a ring + dot at each marker, kept a constant size on screen and drawn over the
// model, with the marker's value pill. Shared by the 3D and the 2D canvases (inside their floating-origin group).

import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { useFocusStore, type FocusMarker } from '@ui/store/focusStore';
import { ProjectedLabel } from './3d/ProjectedLabel';
import { useDisposable } from './useDisposable';

const RENDER_ORDER = 1000;
/** Beacon radius as a fraction of the visible view height. */
const SCREEN_FRACTION = 0.018;
const scratch = new THREE.Vector3();

/** World units per screen-height for the current camera at `position`. */
function viewHeightAt(camera: THREE.Camera, position: THREE.Vector3): number {
  if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom;
  if (camera instanceof THREE.PerspectiveCamera) {
    const distance = camera.getWorldPosition(scratch).distanceTo(position);
    return 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  }
  return 1;
}

function Beacon({ position, color }: { position: Vec3; color: string }): React.ReactElement {
  const group = useRef<THREE.Group>(null);
  const world = useRef(new THREE.Vector3());
  const ring = useDisposable(
    () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }),
    [color],
  );
  const halo = useDisposable(() => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false }), [color]);
  const core = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false }), []);

  useFrame(({ camera }) => {
    const node = group.current;
    if (node === null) return;
    node.getWorldPosition(world.current);
    node.scale.setScalar(viewHeightAt(camera, world.current) * SCREEN_FRACTION);
    node.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={group} position={position}>
      <mesh material={halo} renderOrder={RENDER_ORDER}>
        <circleGeometry args={[1.6, 32]} />
      </mesh>
      <mesh material={ring} renderOrder={RENDER_ORDER + 1}>
        <ringGeometry args={[1, 1.35, 40]} />
      </mesh>
      <mesh material={core} renderOrder={RENDER_ORDER + 2}>
        <circleGeometry args={[0.35, 20]} />
      </mesh>
    </group>
  );
}

function MarkerBeacon({ marker, color, index }: { marker: FocusMarker; color: string; index: number }): React.ReactElement {
  return (
    <>
      <Beacon position={marker.position} color={color} />
      {marker.label !== undefined && (
        <ProjectedLabel
          position={marker.position}
          text={marker.label}
          className="load-label focus-label"
          borderColor={color}
          opacity={1}
          testId={`focus-label-${index}`}
        />
      )}
    </>
  );
}

export function FocusOverlay(): React.ReactElement | null {
  const focus = useFocusStore((s) => s.focus);
  if (focus === null || focus.markers.length === 0) return null;
  return (
    <group name="focus-overlay">
      {focus.markers.map((marker, index) => (
        <MarkerBeacon key={`${focus.key}:${index}`} marker={marker} color={focus.color} index={index} />
      ))}
    </group>
  );
}
