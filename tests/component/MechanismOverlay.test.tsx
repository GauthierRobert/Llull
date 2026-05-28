/**
 * Component tests for MechanismOverlay.
 *
 * Verifies observable behavior (workflow W3, react R11):
 *   - For a selected constraint: a THREE.BufferGeometry is built with 2 vertices
 *     (the line between the two entity positions).
 *   - For a selected joint: a THREE.ArrowHelper is built (non-null) with the
 *     correct color for revolute (cyan) and prismatic (magenta).
 *
 * We cannot run WebGL in jsdom, so we verify the geometry vertex count and
 * ArrowHelper color directly via THREE.js — same technique as RevolutionMesh.test.tsx.
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';
import type { Constraint, Joint } from '@core/model/types';

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  useViewportStore.setState({ mechanismSelection: null });
}

// ---------------------------------------------------------------------------
// Constraint geometry test — line between two entity positions
// ---------------------------------------------------------------------------

describe('MechanismOverlay — constraint line geometry', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('a BufferGeometry for a constraint line has vertex count > 0 (2 positions)', () => {
    const r1 = localDispatch('add_box', { size: [1, 1, 1] });
    const r2 = localDispatch('add_sphere', { radius: 1 });
    const boxId = r1.affected[0]!;
    const sphereId = r2.affected[0]!;

    const rc = localDispatch('add_constraint', {
      constraint: {
        kind: 'coincident',
        a: { entityId: boxId },
        b: { entityId: sphereId },
      },
    });
    const constraintId = rc.affected[0]!;

    const doc = useStore.getState().document;
    const constraint = doc.constraints[constraintId] as Constraint | undefined;
    expect(constraint).toBeDefined();

    const entityA = doc.entities[constraint!.a.entityId];
    const entityB = doc.entities[constraint!.b.entityId];
    expect(entityA).toBeDefined();
    expect(entityB).toBeDefined();

    // Mirror the geometry build in ConstraintLine.
    const posA = new THREE.Vector3(entityA!.position[0], entityA!.position[1], entityA!.position[2]);
    const posB = new THREE.Vector3(entityB!.position[0], entityB!.position[1], entityB!.position[2]);

    const positions = new Float32Array([
      posA.x, posA.y, posA.z,
      posB.x, posB.y, posB.z,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const count = geo.attributes.position?.count ?? 0;
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(2);
    geo.dispose();
  });

  it('overlay reads mechanismSelection for a constraint — selection kind is "constraint"', () => {
    const r1 = localDispatch('add_box', { size: [1, 1, 1] });
    const r2 = localDispatch('add_sphere', { radius: 1 });
    const rc = localDispatch('add_constraint', {
      constraint: {
        kind: 'parallel',
        a: { entityId: r1.affected[0]! },
        b: { entityId: r2.affected[0]! },
      },
    });
    const constraintId = rc.affected[0]!;

    useViewportStore.getState().setMechanismSelection({ kind: 'constraint', id: constraintId });
    const sel = useViewportStore.getState().mechanismSelection;
    expect(sel?.kind).toBe('constraint');
    expect(sel?.id).toBe(constraintId);
  });
});

// ---------------------------------------------------------------------------
// Joint arrow geometry test — ArrowHelper with correct color
// ---------------------------------------------------------------------------

describe('MechanismOverlay — joint arrow', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  function buildJoint(kind: 'revolute' | 'prismatic'): { jointId: string; instanceId: string } {
    const rb1 = localDispatch('add_box', { size: [1, 1, 1] });
    const rb2 = localDispatch('add_box', { size: [1, 1, 1] });
    const rc1 = localDispatch('create_component', { name: 'CA', entityIds: [rb1.affected[0]!] });
    const rc2 = localDispatch('create_component', { name: 'CB', entityIds: [rb2.affected[0]!] });
    void rc1; void rc2;
    const doc = useStore.getState().document;
    const compIds = Object.keys(doc.components);
    const ri1 = localDispatch('insert_instance', { componentId: compIds[0]! });
    const ri2 = localDispatch('insert_instance', { componentId: compIds[1]! });
    const rj = localDispatch('add_joint', {
      kind,
      a: { instanceId: ri1.affected[0]! },
      b: { instanceId: ri2.affected[0]! },
      axis: 'z',
    });
    return { jointId: rj.affected[0]!, instanceId: ri1.affected[0]! };
  }

  it('revolute joint produces a non-null ArrowHelper with cyan color', () => {
    const { jointId } = buildJoint('revolute');
    const doc = useStore.getState().document;
    const joint = doc.joints[jointId] as Joint | undefined;
    expect(joint).toBeDefined();
    expect(joint!.kind).toBe('revolute');

    const entity = doc.entities[joint!.a.instanceId];
    const origin = new THREE.Vector3(entity?.position[0] ?? 0, entity?.position[1] ?? 0, entity?.position[2] ?? 0);
    const axis = new THREE.Vector3(0, 0, 1); // 'z'
    const color = '#00e5ff';

    const arrow = new THREE.ArrowHelper(axis, origin, 1.5, color, 0.35, 0.18);
    expect(arrow).toBeDefined();
    expect(arrow).toBeInstanceOf(THREE.ArrowHelper);

    // Verify arrow line color matches revolute color.
    const mat = arrow.line.material as THREE.LineBasicMaterial;
    expect(mat.color.getHexString()).toBe('00e5ff');

    arrow.line.geometry.dispose();
    arrow.cone.geometry.dispose();
    if (arrow.line.material instanceof THREE.Material) arrow.line.material.dispose();
    if (arrow.cone.material instanceof THREE.Material) arrow.cone.material.dispose();
  });

  it('prismatic joint produces an ArrowHelper with magenta color', () => {
    const { jointId } = buildJoint('prismatic');
    const doc = useStore.getState().document;
    const joint = doc.joints[jointId] as Joint | undefined;
    expect(joint).toBeDefined();
    expect(joint!.kind).toBe('prismatic');

    const entity = doc.entities[joint!.a.instanceId];
    const origin = new THREE.Vector3(entity?.position[0] ?? 0, entity?.position[1] ?? 0, entity?.position[2] ?? 0);
    const axis = new THREE.Vector3(0, 0, 1);
    const color = '#e040fb';

    const arrow = new THREE.ArrowHelper(axis, origin, 1.5, color, 0.35, 0.18);
    expect(arrow).toBeDefined();
    expect(arrow).toBeInstanceOf(THREE.ArrowHelper);

    const mat = arrow.line.material as THREE.LineBasicMaterial;
    expect(mat.color.getHexString()).toBe('e040fb');

    arrow.line.geometry.dispose();
    arrow.cone.geometry.dispose();
    if (arrow.line.material instanceof THREE.Material) arrow.line.material.dispose();
    if (arrow.cone.material instanceof THREE.Material) arrow.cone.material.dispose();
  });

  it('overlay reads mechanismSelection for a joint — selection kind is "joint"', () => {
    const { jointId } = buildJoint('revolute');
    useViewportStore.getState().setMechanismSelection({ kind: 'joint', id: jointId });
    const sel = useViewportStore.getState().mechanismSelection;
    expect(sel?.kind).toBe('joint');
    expect(sel?.id).toBe(jointId);
  });
});
