/**
 * @layer ui/viewport/3d
 * Cue for the constraint/joint highlighted in the MechanismsPanel: a dashed line + kind label
 * between the two constrained entities, or an axis arrow at joint instance `a` (revolute = cyan,
 * prismatic = magenta). Presentational only; mounted inside the floating-origin group.
 */

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import type { CadDocument, Constraint, Joint, Vec3 } from '@core/model/types';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';

const REVOLUTE_COLOR = '#00e5ff';
const PRISMATIC_COLOR = '#e040fb';
const CONSTRAINT_COLOR = '#ffd740';

/** Resolve a joint axis (shorthand or Vec3) to a THREE.Vector3. */
function resolveAxis(axis: Joint['axis']): THREE.Vector3 {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  if (axis === 'z') return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
}

type Entities = CadDocument['entities'];

const ORIGIN: Vec3 = [0, 0, 0];

/** Position of an entity (stable reference while it is unedited), or the origin if missing. */
function positionOf(entityId: string, entities: Entities): Vec3 {
  return entities[entityId]?.position ?? ORIGIN;
}

function ConstraintLine({
  constraint,
  entities,
}: {
  constraint: Constraint;
  entities: Entities;
}): React.ReactElement | null {
  const posA = positionOf(constraint.a.entityId, entities);
  const posB = positionOf(constraint.b.entityId, entities);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...posA, ...posB], 3));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }, [posA, posB]);

  const material = useMemo(
    () =>
      new THREE.LineDashedMaterial({
        color: CONSTRAINT_COLOR,
        dashSize: 0.3,
        gapSize: 0.15,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      }),
    [],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  if (Math.hypot(posB[0] - posA[0], posB[1] - posA[1], posB[2] - posA[2]) < 1e-6) return null;

  return (
    <>
      <lineSegments geometry={geometry} material={material} renderOrder={998} />
      <Text
        font={TEXT_FONT_URL}
        position={[
          (posA[0] + posB[0]) / 2,
          (posA[1] + posB[1]) / 2,
          (posA[2] + posB[2]) / 2 + 0.25,
        ]}
        fontSize={0.35}
        color={CONSTRAINT_COLOR}
        anchorX="center"
        anchorY="middle"
        depthOffset={-1}
        renderOrder={999}
        data-testid="constraint-label"
      >
        {constraint.kind}
      </Text>
    </>
  );
}

const ARROW_LENGTH = 1.5;
const ARROW_HEAD_LENGTH = 0.35;
const ARROW_HEAD_WIDTH = 0.18;

function JointArrow({ joint, entities }: { joint: Joint; entities: Entities }): React.ReactElement {
  const origin = positionOf(joint.a.instanceId, entities);
  const color = joint.kind === 'revolute' ? REVOLUTE_COLOR : PRISMATIC_COLOR;

  const arrowHelper = useMemo(
    () =>
      new THREE.ArrowHelper(
        resolveAxis(joint.axis),
        new THREE.Vector3(...origin),
        ARROW_LENGTH,
        color,
        ARROW_HEAD_LENGTH,
        ARROW_HEAD_WIDTH,
      ),
    [origin, joint.axis, color],
  );

  useEffect(
    () => () => {
      arrowHelper.line.geometry.dispose();
      if (arrowHelper.line.material instanceof THREE.Material) arrowHelper.line.material.dispose();
      arrowHelper.cone.geometry.dispose();
      if (arrowHelper.cone.material instanceof THREE.Material) arrowHelper.cone.material.dispose();
    },
    [arrowHelper],
  );

  return <primitive object={arrowHelper} renderOrder={998} />;
}

/** Renders the overlay for the viewport-store `mechanismSelection`; invalidates the demand canvas on change. */
export function MechanismOverlay(): React.ReactElement | null {
  const mechanismSelection = useViewportStore((s) => s.mechanismSelection);
  const entities = useStore((s) => s.document.entities);
  const constraints = useStore((s) => s.document.constraints);
  const joints = useStore((s) => s.document.joints);
  const { invalidate } = useThree();

  useEffect(() => {
    invalidate();
  }, [mechanismSelection, invalidate]);

  if (!mechanismSelection) return null;

  if (mechanismSelection.kind === 'constraint') {
    const constraint = constraints[mechanismSelection.id];
    if (!constraint) return null;
    return <ConstraintLine constraint={constraint} entities={entities} />;
  }

  if (mechanismSelection.kind === 'joint') {
    const joint = joints[mechanismSelection.id];
    if (!joint) return null;
    return <JointArrow joint={joint} entities={entities} />;
  }

  return null;
}
