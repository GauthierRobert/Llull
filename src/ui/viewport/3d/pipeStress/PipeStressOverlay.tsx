// Paints the elements of the reviewed stress model (building pipes and 02 RTE runs) by the worst code-stress ratio of each element (green below
// 0.8, amber to 1, red above 1) over the load case chosen in the pipe stress panel, draws the support reaction arrows and, when asked, the
// deformed shape x scale. Data: the read-only `analyze_pipe_stress` with geometry, recomputed when the document changes (never on selection)
// and shared with the panel. Positions are absolute document coordinates (mm converted to document units), inside the floating-origin group.
// One InstancedMesh per tone: the draw calls do not grow with the element count.

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MM_PER_UNIT } from '@core/model/units';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { usePipeStressStore } from '@ui/store/pipeStressStore';
import { useDisposable } from '../../useDisposable';
import { groupByTone, paintedElements, type PaintedElement } from './paintedElements';
import { reactionArrows, type ReactionArrow } from './reactionArrows';
import type { SegmentPose } from './segmentPose';
import { stressOutcome } from './stressQuery';
import { TONE_COLOR, type RatioTone } from './stressView';

const RENDER_ORDER = 997;
const ARROW_COLOR = '#38bdf8';
const TONES: readonly RatioTone[] = ['pass', 'warn', 'fail', 'unknown'];

const noRaycast = (): void => undefined;

function overlayMaterial(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false });
}

const matrix = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();

/** Pose of a unit cylinder (radius 1, height 1, along +Y) as a matrix: `radius` across, `pose.length` along. */
function poseMatrix(pose: SegmentPose, radius: number): THREE.Matrix4 {
  position.set(...pose.center);
  quaternion.set(...pose.quaternion);
  scale.set(radius, pose.length, radius);
  return matrix.compose(position, quaternion, scale);
}

function ToneInstances({
  tone,
  elements,
  material,
}: {
  tone: RatioTone;
  elements: PaintedElement[];
  material: THREE.Material;
}): React.ReactElement {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const instanced = mesh.current;
    if (instanced === null) return;
    elements.forEach((element, i) => instanced.setMatrixAt(i, poseMatrix(element.pose, element.radius)));
    instanced.instanceMatrix.needsUpdate = true;
  }, [elements]);
  return (
    <instancedMesh
      // The instance count is fixed at construction: a new count is a new mesh.
      key={elements.length}
      ref={mesh}
      name={`pipe-stress-${tone}`}
      args={[undefined, undefined, elements.length]}
      material={material}
      renderOrder={RENDER_ORDER}
      frustumCulled={false}
      raycast={noRaycast}
      userData={{ tone, elementIds: elements.map((element) => element.id) }}
    >
      <cylinderGeometry args={[1, 1, 1, 12]} />
    </instancedMesh>
  );
}

function Arrow({
  arrow,
  shaftGeometry,
  headGeometry,
  material,
}: {
  arrow: ReactionArrow;
  shaftGeometry: THREE.BufferGeometry;
  headGeometry: THREE.BufferGeometry;
  material: THREE.Material;
}): React.ReactElement {
  return (
    <group name={`pipe-stress-reaction-${arrow.nodeId}`} userData={{ forceN: arrow.forceN, magnitudeN: arrow.magnitudeN }}>
      <mesh
        geometry={shaftGeometry}
        material={material}
        position={arrow.shaft.center}
        quaternion={arrow.shaft.quaternion}
        scale={[arrow.shaftRadius, arrow.shaft.length, arrow.shaftRadius]}
        renderOrder={RENDER_ORDER + 1}
        raycast={noRaycast}
      />
      <mesh
        geometry={headGeometry}
        material={material}
        position={arrow.head.center}
        quaternion={arrow.head.quaternion}
        scale={[arrow.headRadius, arrow.head.length, arrow.headRadius]}
        renderOrder={RENDER_ORDER + 1}
        raycast={noRaycast}
      />
    </group>
  );
}

export function PipeStressOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const modelId = usePipeStressStore((s) => s.modelId);
  const caseName = usePipeStressStore((s) => s.caseName);
  const shown = usePipeStressStore((s) => s.shown);
  const showReactions = usePipeStressStore((s) => s.showReactions);
  const deformScale = usePipeStressStore((s) => s.deformScale);
  const invalidate = useThree((state) => state.invalidate);
  const pass = useDisposable(() => overlayMaterial(TONE_COLOR.pass), []);
  const warn = useDisposable(() => overlayMaterial(TONE_COLOR.warn), []);
  const fail = useDisposable(() => overlayMaterial(TONE_COLOR.fail), []);
  const unknown = useDisposable(() => overlayMaterial(TONE_COLOR.unknown), []);
  const arrowMaterial = useDisposable(() => overlayMaterial(ARROW_COLOR), []);
  const shaftGeometry = useDisposable(() => new THREE.CylinderGeometry(1, 1, 1, 8), []);
  const headGeometry = useDisposable(() => new THREE.ConeGeometry(1, 1, 12), []);
  const materials: Record<RatioTone, THREE.Material> = { pass, warn, fail, unknown };
  const painted = useMemo(() => {
    const outcome = !shown || modelId === null ? null : stressOutcome(document, modelId);
    if (outcome === null || !outcome.ok) return { groups: null, arrows: [] as ReactionArrow[] };
    const mmPerUnit = MM_PER_UNIT[document.units];
    return {
      groups: groupByTone(paintedElements(outcome.view, caseName, deformScale, mmPerUnit)),
      arrows: showReactions ? reactionArrows(outcome.view, caseName, mmPerUnit) : [],
    };
  }, [shown, modelId, caseName, deformScale, showReactions, document]);
  useEffect(() => invalidate(), [painted, invalidate]);
  if (painted.groups === null) return null;
  const { groups, arrows } = painted;
  return (
    <group name="pipe-stress">
      {TONES.map((tone) =>
        groups[tone].length === 0 ? null : <ToneInstances key={tone} tone={tone} elements={groups[tone]} material={materials[tone]} />,
      )}
      {arrows.map((arrow) => (
        <Arrow key={arrow.nodeId} arrow={arrow} shaftGeometry={shaftGeometry} headGeometry={headGeometry} material={arrowMaterial} />
      ))}
    </group>
  );
}
