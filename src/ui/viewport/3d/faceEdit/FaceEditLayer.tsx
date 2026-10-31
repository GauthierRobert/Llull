// In-Canvas layer of B-rep face handle editing (04 DIR M1), inside the floating-origin group (positions are world space): the hovered and
// picked patches and the handle arrow on the picked face. Input comes from useFacePointer / useFaceKeys; the ghost from RemotePreviewLayer.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { runHostQuery } from '@ui/panels/analysis/useHostQuery';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { useDisposable } from '../../useDisposable';
import { ArrowShape } from '../ArrowShape';
import { previewGeometry } from '../preview/previewGeometry';
import { CAGE_COLORS } from '../cage/cagePalette';
import { unitsPerPixel } from '../cage/dragMath';
import { HANDLE_PX } from './faceDragMath';
import { canEditFaces } from './faceEditModel';
import { regionPositions } from './faceMesh';
import { faceLabels } from './facePicking';
import { pickableTriangles } from './faceTriangles';
import { useFaceKeys } from './useFaceKeys';
import { useFacePointer } from './useFacePointer';

function Patch({ positions, color, opacity }: { positions: number[]; color: string; opacity: number }): React.ReactElement | null {
  const anchored = useDisposable(() => {
    const built = previewGeometry({ positions });
    return { ...built, dispose: () => built.geometry.dispose() };
  }, [positions]);
  const material = useDisposable(
    () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }),
    [color, opacity],
  );
  return positions.length === 0 ? null : (
    <mesh
      geometry={anchored.geometry}
      material={material}
      position={[...anchored.anchor]}
      renderOrder={18}
      raycast={() => null}
      frustumCulled={false}
    />
  );
}

function Handle(): React.ReactElement | null {
  const pick = useFaceEditStore((s) => s.pick);
  const value = useFaceEditStore((s) => s.value);
  const op = useFaceEditStore((s) => s.op);
  const groupRef = useRef<THREE.Group>(null);
  const height = useThree((s) => s.size.height);
  const material = useDisposable(() => new THREE.MeshBasicMaterial({ color: CAGE_COLORS.selected, depthTest: false }), []);
  const quaternion = useMemo(
    () =>
      pick === null
        ? new THREE.Quaternion()
        : new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...pick.normal)),
    [pick],
  );
  // Constant on-screen size: the arrow is one unit long, scaled each frame by the world size of HANDLE_PX at its distance.
  useFrame(({ camera }) => {
    const group = groupRef.current;
    if (group === null) return;
    const distance = camera.position.distanceTo(group.getWorldPosition(new THREE.Vector3()));
    group.scale.setScalar(Math.max(1e-6, unitsPerPixel(distance, VIEWPORT_FOV_DEGREES, height) * HANDLE_PX));
  });
  if (pick === null || op === 'move_feature') return null;
  const shift = value !== null && op !== 'draft' ? value : 0;
  const position = [
    pick.point[0] + pick.normal[0] * shift,
    pick.point[1] + pick.normal[1] * shift,
    pick.point[2] + pick.normal[2] * shift,
  ] as const;
  return (
    <group ref={groupRef} position={[...position]} quaternion={quaternion} name="face-handle">
      <ArrowShape material={material} length={1} head={0.28} radius={0.025} renderOrder={24} />
    </group>
  );
}

export function FaceEditLayer(): React.ReactElement | null {
  const active = useFaceEditStore((s) => s.active);
  const sole = useSoleSelectedEntity();
  const target = canEditFaces(sole) ? sole : undefined;
  const pickEntity = useFaceEditStore((s) => s.entityId);
  const region = useFaceEditStore((s) => s.region);
  const hover = useFaceEditStore((s) => s.hover);
  const invalidate = useThree((s) => s.invalidate);
  useFacePointer(active ? target : undefined);
  useFaceKeys(active && target !== undefined);

  // The kernel names the face of every display triangle (exact highlight); without it (mesh kernel, too many triangles) the picker falls back to its heuristic.
  useEffect(() => {
    if (!active || target === undefined) {
      useFaceEditStore.getState().setLabels(null);
      return undefined;
    }
    let cancelled = false;
    void runHostQuery('inspect_face_triangles', { entityId: target.id }).then(({ data, isError }) => {
      if (cancelled) return;
      const faces =
        !isError && typeof data === 'object' && data !== null ? (data as { faceOfTriangle?: unknown }).faceOfTriangle : undefined;
      useFaceEditStore.getState().setLabels(Array.isArray(faces) ? { entity: target, value: faceLabels(faces as number[]) } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [active, target]);
  // A pick belongs to one version of one entity: a new selection or a committed edit drops it.
  useEffect(() => {
    const edit = useFaceEditStore.getState();
    if (edit.active && edit.entityId !== null && edit.entityId !== target?.id) edit.clearPick();
  }, [target?.id]);
  useEffect(() => {
    if (active && target === undefined) useFaceEditStore.getState().stop();
  }, [active, target]);
  const pick = useFaceEditStore((s) => s.pick);
  useEffect(() => invalidate(), [pick, hover, region, invalidate]);

  const patches = useMemo(() => {
    if (target === undefined || !active) return { picked: [] as number[], hovered: [] as number[] };
    const { triangles } = pickableTriangles(target);
    return {
      picked: pickEntity === target.id ? regionPositions(triangles, region) : [],
      hovered: hover === null ? [] : regionPositions(triangles, hover.region),
    };
  }, [target, active, pickEntity, region, hover]);

  if (!active || target === undefined) return null;
  return (
    <group name="face-edit">
      <Patch positions={patches.hovered} color={CAGE_COLORS.hover} opacity={0.22} />
      <Patch positions={patches.picked} color={CAGE_COLORS.selected} opacity={0.32} />
      <Handle />
    </group>
  );
}
