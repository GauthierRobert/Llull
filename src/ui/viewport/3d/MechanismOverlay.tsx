// Cue for the MechanismsPanel highlight: dashed line + kind label between constrained entities, or an axis arrow at
// joint instance `a` (revolute cyan, prismatic magenta); inside the floating-origin group.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import type { CadDocument, Constraint, Joint, Vec3 } from '@core/model/types';
import { axisVector } from '@lib/axis';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';
import { positionsGeometry } from '../lineGeometry';
import { useDisposable } from '../useDisposable';

const REVOLUTE_COLOR = '#00e5ff';
const PRISMATIC_COLOR = '#e040fb';
const CONSTRAINT_COLOR = '#ffd740';

function jointAxisDirection(axis: Joint['axis']): THREE.Vector3 {
  return new THREE.Vector3(...axisVector(axis)).normalize();
}

type Entities = CadDocument['entities'];

const ORIGIN: Vec3 = [0, 0, 0];

/** Stable while unedited; origin when missing. */
function positionOf(entityId: string, entities: Entities): Vec3 {
  return entities[entityId]?.position ?? ORIGIN;
}

function ConstraintLine({ constraint, entities }: { constraint: Constraint; entities: Entities }): React.ReactElement | null {
  const posA = positionOf(constraint.a.entityId, entities);
  const posB = positionOf(constraint.b.entityId, entities);

  const geometry = useDisposable(() => positionsGeometry([...posA, ...posB]), [posA, posB]);
  const material = useDisposable(
    () =>
      new THREE.LineDashedMaterial({
        color: CONSTRAINT_COLOR,
        dashSize: 0.3,
        gapSize: 0.15,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      }),
    [],
  );

  if (Math.hypot(posB[0] - posA[0], posB[1] - posA[1], posB[2] - posA[2]) < 1e-6) return null;

  return (
    <>
      <lineSegments geometry={geometry} material={material} renderOrder={998} />
      <Text
        font={TEXT_FONT_URL}
        position={[(posA[0] + posB[0]) / 2, (posA[1] + posB[1]) / 2, (posA[2] + posB[2]) / 2 + 0.25]}
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

  const arrowHelper = useDisposable(
    () =>
      new THREE.ArrowHelper(
        jointAxisDirection(joint.axis),
        new THREE.Vector3(...origin),
        ARROW_LENGTH,
        color,
        ARROW_HEAD_LENGTH,
        ARROW_HEAD_WIDTH,
      ),
    [origin, joint.axis, color],
  );

  return <primitive object={arrowHelper} renderOrder={998} />;
}

/** Invalidates the demand canvas on change. */
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
