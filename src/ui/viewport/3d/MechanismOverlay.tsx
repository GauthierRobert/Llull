/**
 * @layer ui/viewport/3d
 *
 * MechanismOverlay — renders a 3D visual cue when one constraint or joint is
 * highlighted in the MechanismsPanel.
 *
 * Constraint selection:
 *   A dashed THREE.Line connecting the positions of the two referenced entities.
 *   A troika <Text> label at the midpoint showing the constraint kind.
 *
 * Joint selection:
 *   A short axis arrow at instance `a`'s position along the joint axis vector.
 *   Color: revolute = cyan (#00e5ff), prismatic = magenta (#e040fb).
 *
 * R9: geometry and material are memoized and disposed on unmount / change.
 * R3: reads mechanismSelection from a narrow viewport-store selector.
 * PRIME DIRECTIVE: purely presentational — no dispatch, no document mutation.
 *
 * Must be mounted inside the r3f Canvas (inside the floating-origin group
 * in SceneContents, same as MeasureBBoxWireframe).
 */

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import type { Constraint, Joint, Vec3 } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Get the world position of an entity by id, or [0,0,0] if not found. */
function entityPosition(entityId: string, entities: Record<string, { position: Vec3 }>): THREE.Vector3 {
  const e = entities[entityId];
  if (!e) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(e.position[0], e.position[1], e.position[2]);
}

// ---------------------------------------------------------------------------
// ConstraintLine — line between the two entity positions + label
// ---------------------------------------------------------------------------

interface ConstraintLineProps {
  constraint: Constraint;
  entities: Record<string, { position: Vec3 }>;
}

function ConstraintLine({ constraint, entities }: ConstraintLineProps): React.ReactElement | null {
  const posA = entityPosition(constraint.a.entityId, entities);
  const posB = entityPosition(constraint.b.entityId, entities);

  const geometry = useMemo(() => {
    const positions = new Float32Array([
      posA.x, posA.y, posA.z,
      posB.x, posB.y, posB.z,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posA.x, posA.y, posA.z, posB.x, posB.y, posB.z]);

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

  useEffect(() => {
    // computeLineDistances is required for LineDashedMaterial dash rendering.
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const midpoint = useMemo(() => new THREE.Vector3().addVectors(posA, posB).multiplyScalar(0.5), [
    posA.x, posA.y, posA.z, posB.x, posB.y, posB.z,
  ]);

  if (posA.distanceTo(posB) < 1e-6) return null;

  return (
    <>
      <lineSegments geometry={geometry} material={material} renderOrder={998} />
      <Text
        position={[midpoint.x, midpoint.y + 0.25, midpoint.z]}
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

// ---------------------------------------------------------------------------
// JointArrow — axis arrow at instance a's position
// ---------------------------------------------------------------------------

interface JointArrowProps {
  joint: Joint;
  entities: Record<string, { position: Vec3 }>;
}

const ARROW_LENGTH = 1.5;
const ARROW_HEAD_LENGTH = 0.35;
const ARROW_HEAD_WIDTH = 0.18;

function JointArrow({ joint, entities }: JointArrowProps): React.ReactElement | null {
  const origin = entityPosition(joint.a.instanceId, entities);
  const axisVec = useMemo(() => resolveAxis(joint.axis), [joint.axis]);
  const color = joint.kind === 'revolute' ? REVOLUTE_COLOR : PRISMATIC_COLOR;

  // ArrowHelper: THREE.ArrowHelper creates its own geometry/material and handles disposal.
  const arrowHelper = useMemo(() => {
    return new THREE.ArrowHelper(
      axisVec,
      origin,
      ARROW_LENGTH,
      color,
      ARROW_HEAD_LENGTH,
      ARROW_HEAD_WIDTH,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin.x, origin.y, origin.z, axisVec.x, axisVec.y, axisVec.z, color]);

  useEffect(() => {
    return () => {
      arrowHelper.line.geometry.dispose();
      if (arrowHelper.line.material instanceof THREE.Material) arrowHelper.line.material.dispose();
      arrowHelper.cone.geometry.dispose();
      if (arrowHelper.cone.material instanceof THREE.Material) arrowHelper.cone.material.dispose();
    };
  }, [arrowHelper]);

  return <primitive object={arrowHelper} renderOrder={998} />;
}

// ---------------------------------------------------------------------------
// MechanismOverlay — exported; mount inside the floating-origin group
// ---------------------------------------------------------------------------

/**
 * Reads the viewport-store `mechanismSelection` and renders the appropriate
 * overlay geometry (constraint line or joint arrow) inside the r3f scene.
 *
 * Calls `invalidate()` when the selection changes so the demand-mode canvas
 * redraws immediately (mirrors the MeasureBBoxWireframe pattern).
 */
export function MechanismOverlay(): React.ReactElement | null {
  const mechanismSelection = useViewportStore((s) => s.mechanismSelection);
  const entities = useStore((s) => s.document.entities) as Record<string, { position: Vec3 }>;
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
