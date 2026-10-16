/** Regression guards for evaluate_motion / bake_motion (kinematic instance joints): chains and tilted axes. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';
import { applyEulerXYZ } from '@lib/eulerRotation';

function instanceAt(doc: CadDocument, position: Vec3): { doc: CadDocument; id: string } {
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const name = `part${Object.keys(box.document.components).length}`;
  const withComponent = execute(box.document, 'create_component', { name, entityIds: [box.affected[0]] }).document;
  const componentId = Object.keys(withComponent.components).at(-1);
  const instance = execute(withComponent, 'insert_instance', { componentId, position });
  return { doc: instance.document, id: instance.affected[0] ?? '' };
}

interface Motion {
  instancePositions: Record<string, Vec3>;
  instanceRotations: Record<string, Vec3>;
}

const close = (actual: readonly number[] | undefined, expected: readonly number[]): void =>
  expected.forEach((value, i) => expect(actual?.[i]).toBeCloseTo(value, 9));

describe('kinematic joints', () => {
  it('a chained joint follows its parent: arm → forearm rotated 90° as one rigid chain', () => {
    const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
    const arm = instanceAt(ground.doc, [10, 0, 0]);
    const hand = instanceAt(arm.doc, [20, 0, 0]);
    const shoulder = execute(hand.doc, 'add_joint', {
      kind: 'revolute',
      a: { instanceId: ground.id },
      b: { instanceId: arm.id },
      axis: 'z',
    });
    const elbow = execute(shoulder.document, 'add_joint', {
      kind: 'revolute',
      a: { instanceId: arm.id },
      b: { instanceId: hand.id },
      axis: 'z',
    });
    const posed = execute(elbow.document, 'set_joint_value', { id: shoulder.affected[0], value: Math.PI / 2 }).document;
    const motion = execute(posed, 'evaluate_motion', {}).data as Motion;
    close(motion.instancePositions[arm.id], [0, 10, 0]);
    close(motion.instancePositions[hand.id], [0, 20, 0]);
    close(motion.instanceRotations[hand.id], [0, 0, Math.PI / 2]);
    // bending the elbow too: the hand turns about the arm's moved origin
    const bent = execute(posed, 'set_joint_value', { id: elbow.affected[0], value: Math.PI / 2 }).document;
    const both = execute(bent, 'evaluate_motion', {}).data as Motion;
    close(both.instancePositions[hand.id], [-10, 10, 0]);
    close(both.instanceRotations[hand.id], [0, 0, Math.PI]);
  });

  it('a tilted axis gives the true rotation (not per-axis Euler sums): 180° about [1,1,0]', () => {
    const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
    const part = instanceAt(ground.doc, [0, 0, 5]);
    const axis: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const joint = execute(part.doc, 'add_joint', { kind: 'revolute', a: { instanceId: ground.id }, b: { instanceId: part.id }, axis });
    const posed = execute(joint.document, 'set_joint_value', { id: joint.affected[0], value: Math.PI }).document;
    const motion = execute(posed, 'evaluate_motion', {}).data as Motion;
    close(motion.instancePositions[part.id], [0, 0, -5]);
    // the stored Euler angles must map X onto Y and Y onto X (a half turn about the diagonal)
    const euler = motion.instanceRotations[part.id] ?? [0, 0, 0];
    close(applyEulerXYZ([1, 0, 0], [0, 0, 0], euler), [0, 1, 0]);
    close(applyEulerXYZ([0, 1, 0], [0, 0, 0], euler), [1, 0, 0]);
    close(applyEulerXYZ([0, 0, 1], [0, 0, 0], euler), [0, 0, -1]);
  });

  it('a prismatic child of a rotated parent slides along the rotated axis', () => {
    const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
    const arm = instanceAt(ground.doc, [10, 0, 0]);
    const slider = instanceAt(arm.doc, [10, 0, 0]);
    const hinge = execute(slider.doc, 'add_joint', {
      kind: 'revolute',
      a: { instanceId: ground.id },
      b: { instanceId: arm.id },
      axis: 'z',
    });
    const rail = execute(hinge.document, 'add_joint', {
      kind: 'prismatic',
      a: { instanceId: arm.id },
      b: { instanceId: slider.id },
      axis: 'x',
    });
    let doc = execute(rail.document, 'set_joint_value', { id: hinge.affected[0], value: Math.PI / 2 }).document;
    doc = execute(doc, 'set_joint_value', { id: rail.affected[0], value: 3 }).document;
    const motion = execute(doc, 'evaluate_motion', {}).data as Motion;
    close(motion.instancePositions[slider.id], [0, 13, 0]);
  });
});
