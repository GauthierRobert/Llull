// In-Canvas gizmo of the active review section box: its outline and a grip on each face. Dragging a grip moves that face along its normal
// (live through sectionBoxDraftStore, so the clipping follows); release commits ONE `set_section_box` (like the transform gizmo).
// The plane form of a section box has no faces to drag and is drawn by its clipping only.

import { useEffect, useMemo, useRef } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { SectionBox } from '@core/model/review';
import type { Vec3 } from '@core/model/vectors';
import { useStore } from '@ui/store';
import { useSectionBoxDraftStore } from '@ui/store/sectionBoxDraftStore';
import { toRenderPosition } from '../floatingOrigin';
import { axisParamFromRay } from '../manipulators/manipulatorMath';
import { capturePointer, releasePointer } from '../pointerCapture';
import { type SectionFace, resizeSectionFace, sectionFaces, withBounds } from './sectionBoxMath';

const OUTLINE_COLOUR = '#f5a524';
/** The gizmo lies this fraction of its size inside the faces: on a face itself the global clipping planes would cut it. */
const INSET = 3e-4;

interface GripProps {
  face: SectionFace;
  box: SectionBox;
  scale: number;
}

function FaceGrip({ face, box, scale }: GripProps): React.ReactElement {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const renderOrigin = useStore((s) => s.renderOrigin);
  const drag = useRef<{ param: number; distance: number; origin: Vec3; latest: SectionBox } | null>(null);
  const quaternion = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...face.normal)),
    [face.normal],
  );
  const size = scale * 0.06;
  const inset = scale * INSET;
  const position = useMemo<Vec3>(
    () => [face.centre[0] - face.normal[0] * inset, face.centre[1] - face.normal[1] * inset, face.centre[2] - face.normal[2] * inset],
    [face, inset],
  );

  const rayOf = (event: ThreeEvent<PointerEvent>): { origin: Vec3; direction: Vec3 } => ({
    origin: [event.ray.origin.x, event.ray.origin.y, event.ray.origin.z],
    direction: [event.ray.direction.x, event.ray.direction.y, event.ray.direction.z],
  });

  const onPointerDown = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation();
    const origin = toRenderPosition(face.centre, renderOrigin);
    const ray = rayOf(event);
    const param = axisParamFromRay(origin, face.normal, ray.origin, ray.direction);
    if (param === null) return;
    drag.current = { param, distance: face.distance, origin, latest: box };
    capturePointer(event.target as EventTarget, event.pointerId);
    if (controls !== null) controls.enabled = false;
  };
  const onPointerMove = (event: ThreeEvent<PointerEvent>): void => {
    const state = drag.current;
    if (state === null) return;
    const ray = rayOf(event);
    const param = axisParamFromRay(state.origin, face.normal, ray.origin, ray.direction);
    if (param === null) return;
    const bounds = resizeSectionFace(box, face.axis, face.sign, state.distance + (param - state.param));
    if (bounds === null) return;
    state.latest = withBounds(box, bounds);
    useSectionBoxDraftStore.getState().setDraft(state.latest);
  };
  const onPointerUp = (event: ThreeEvent<PointerEvent>): void => {
    const state = drag.current;
    if (state === null) return;
    drag.current = null;
    releasePointer(event.target as EventTarget, event.pointerId);
    if (controls !== null) controls.enabled = true;
    const { latest } = state;
    useSectionBoxDraftStore.getState().setDraft(null);
    if (latest === box || latest.min === undefined || latest.max === undefined) return;
    useStore
      .getState()
      .dispatch('set_section_box', {
        id: box.id,
        name: box.name,
        min: latest.min,
        max: latest.max,
        ...(box.rotationZ === undefined ? {} : { rotationZ: box.rotationZ }),
        activate: true,
      });
  };

  return (
    <mesh
      position={position}
      quaternion={quaternion}
      renderOrder={20}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      userData={{ sectionFace: `${face.axis}${face.sign > 0 ? '+' : '-'}` }}
    >
      <circleGeometry args={[size, 24]} />
      <meshBasicMaterial color={OUTLINE_COLOUR} depthTest={false} transparent opacity={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function SectionBoxGizmo(): React.ReactElement | null {
  const review = useStore((s) => s.document.review);
  const draft = useSectionBoxDraftStore((s) => s.draft);
  const stored = review?.activeSectionBoxId === undefined ? undefined : review.sectionBoxes[review.activeSectionBoxId];
  const box = draft ?? stored;
  const faces = useMemo(() => (box === undefined ? [] : sectionFaces(box)), [box]);

  const outline = useMemo(() => {
    if (box?.min === undefined || box.max === undefined) return null;
    const size = new THREE.Vector3(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    const inset = Math.max(size.x, size.y, size.z) * INSET;
    const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x - 2 * inset, size.y - 2 * inset, size.z - 2 * inset));
    const position = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    return { geometry, position, rotationZ: box.rotationZ ?? 0, scale: Math.max(size.x, size.y, size.z) };
  }, [box]);

  useEffect(() => () => outline?.geometry.dispose(), [outline]);

  if (box === undefined || outline === null) return null;
  return (
    <group name="section-box-gizmo">
      <lineSegments
        geometry={outline.geometry}
        position={outline.position}
        rotation={[0, 0, outline.rotationZ]}
        renderOrder={19}
        raycast={() => undefined}
      >
        <lineBasicMaterial color={OUTLINE_COLOUR} depthTest={false} transparent opacity={0.9} />
      </lineSegments>
      {faces.map((face) => (
        <FaceGrip key={`${face.axis}${face.sign}`} face={face} box={box} scale={outline.scale} />
      ))}
    </group>
  );
}
