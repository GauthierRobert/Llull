import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import {
  animationMembers,
  animationPoseAt,
  animationScalar,
  composeAnimatedPoseInto,
  createAnimatedPose,
  createContribution,
  documentAtAnimation,
  fillAnimationContribution,
  type AnimationContribution,
} from '@core/geometry/animationPose';
import { applyAnimatedPose } from '../../src/ui/viewport/3d/animationMath';

const validation = resolve(process.cwd(), 'docs/physics/22-motion-video/validation');
const spinPlan = (
  JSON.parse(readFileSync(resolve(validation, 'plans/mov_clip_spin.plan.json'), 'utf8')) as { command: string; params: object }[]
).slice(0, 3);
const reference = JSON.parse(readFileSync(resolve(validation, 'mov_reference.json'), 'utf8')) as {
  spinClip: { fps: number; samples: { frame: number; angleRad: number; centreMm: [number, number] }[] };
};

const spinDocument = (): CadDocument => execute(createEmptyDocument(), 'build_project', { actions: spinPlan }).document;
const boxId = (doc: CadDocument): string => doc.order[0] ?? '';

const contribution = (channel: 'rotation' | 'position', axis: [number, number, number], scalar: number): AnimationContribution => ({
  channel,
  axis,
  scalar,
  pivot: [0, 0, 0],
});

function composed(
  base: [number, number, number],
  euler: [number, number, number],
  parts: AnimationContribution[],
): { position: number[]; quaternion: number[] } {
  const pose = createAnimatedPose();
  composeAnimatedPoseInto(pose, base, euler, parts);
  return { position: pose.position, quaternion: pose.quaternion };
}

describe('animationScalar', () => {
  const clip = { speed: 2, amplitude: 3, frequency: 0.5 };
  it('spin is speed times phase', () => {
    expect(animationScalar({ ...clip, mode: 'spin' }, 2.5)).toBeCloseTo(5, 12);
  });
  it('oscillate is amplitude at the quarter period and zero at 0', () => {
    expect(animationScalar({ ...clip, mode: 'oscillate' }, 0)).toBeCloseTo(0, 12);
    expect(animationScalar({ ...clip, mode: 'oscillate' }, 0.5)).toBeCloseTo(3, 12);
    expect(animationScalar({ ...clip, mode: 'oscillate' }, 1.5)).toBeCloseTo(-3, 12);
  });
});

describe('composeAnimatedPoseInto', () => {
  it('leaves the base pose with no contribution', () => {
    const { position, quaternion } = composed([1, 2, 3], [0, 0, 0], []);
    expect(position).toEqual([1, 2, 3]);
    expect(quaternion).toEqual([0, 0, 0, 1]);
  });
  it('turns the position about the pivot and the orientation with it', () => {
    const { position, quaternion } = composed([1, 0, 0], [0, 0, 0], [contribution('rotation', [0, 1, 0], Math.PI)]);
    expect(position[0]).toBeCloseTo(-1, 12);
    expect(quaternion[1]).toBeCloseTo(1, 12);
    expect(quaternion[3]).toBeCloseTo(0, 12);
  });
  it('translates along the axis for a position clip', () => {
    expect(composed([0, 0, 0], [0, 0, 0], [contribution('position', [1, 0, 0], 5)]).position).toEqual([5, 0, 0]);
  });
  it('composes two quarter turns into a half turn', () => {
    const turn = contribution('rotation', [0, 0, 1], Math.PI / 2);
    expect(composed([1, 0, 0], [0, 0, 0], [turn, turn]).position[0]).toBeCloseTo(-1, 12);
  });
  it('matches three.js for the base Euler XYZ orientation', () => {
    const euler: [number, number, number] = [0.3, -0.7, 1.1];
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler, 'XYZ'));
    const { quaternion } = composed([0, 0, 0], euler, []);
    expect(quaternion[0]).toBeCloseTo(expected.x, 12);
    expect(quaternion[1]).toBeCloseTo(expected.y, 12);
    expect(quaternion[2]).toBeCloseTo(expected.z, 12);
    expect(quaternion[3]).toBeCloseTo(expected.w, 12);
  });
});

describe('animationPoseAt (VC-MOV-04)', () => {
  it('puts the spinning box centre on the closed form at frames 0, 5, 10, 15, 20', () => {
    const doc = spinDocument();
    const id = boxId(doc);
    for (const sample of reference.spinClip.samples) {
      const placement = animationPoseAt(doc, sample.frame / reference.spinClip.fps)[id];
      expect(Math.abs((placement?.position[0] ?? NaN) - sample.centreMm[0])).toBeLessThan(1e-9);
      expect(Math.abs((placement?.position[1] ?? NaN) - sample.centreMm[1])).toBeLessThan(1e-9);
      const turned = (((sample.angleRad + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(Math.abs(Math.sin(((placement?.rotation[2] ?? NaN) - (turned - Math.PI)) / 2))).toBeLessThan(1e-9);
    }
  });

  it('is pure: the document is unchanged and documentAtAnimation returns a copy', () => {
    const doc = spinDocument();
    const before = JSON.stringify(doc);
    const moved = documentAtAnimation(doc, 0.5);
    expect(JSON.stringify(doc)).toBe(before);
    expect(moved).not.toBe(doc);
    expect(moved.entities[boxId(doc)]?.position[1]).toBeCloseTo(50, 9);
    expect(doc.entities[boxId(doc)]?.position[1]).toBe(0);
  });

  it('plays auto clips only, skips click clips and missing members', () => {
    const doc = spinDocument();
    const id = boxId(doc);
    const clicked = execute(doc, 'animate', {
      targetId: id,
      mode: 'oscillate',
      amplitude: 1,
      frequency: 1,
      channel: 'position',
      trigger: 'click',
    }).document;
    expect(animationPoseAt(clicked, 0.25)[id]?.position[2]).toBe(0);
    const orphan = { ...doc, entities: {} };
    expect(animationPoseAt(orphan, 1)).toEqual({});
    expect(documentAtAnimation(orphan, 1).entities).toEqual({});
  });

  it('turns a group about the centroid of its members when the clip has no pivot', () => {
    const grouped = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [2, 2, 2], position: [10, 0, 0], anchor: 'center' }, as: 'a' },
        { command: 'add_box', params: { size: [2, 2, 2], position: [20, 0, 0], anchor: 'center' }, as: 'b' },
        { command: 'group_entities', params: { ids: ['$a', '$b'] } },
      ],
    }).document;
    const [groupId] = Object.keys(grouped.groups);
    const doc = execute(grouped, 'animate', { targetId: groupId ?? '', mode: 'spin', speed: Math.PI, axis: [0, 0, 1] }).document;
    const poses = animationPoseAt(doc, 1);
    const [a, b] = Object.values(doc.groups)[0]?.memberIds ?? [];
    expect(poses[a ?? '']?.position[0]).toBeCloseTo(20, 9);
    expect(poses[b ?? '']?.position[0]).toBeCloseTo(10, 9);
    expect(Object.keys(poses)).toHaveLength(2);
    expect(animationMembers({ targetKind: 'group', targetId: 'nope' } as never, doc.groups)).toEqual([]);
  });
});

describe('the viewport adapter and the core pose agree (VC-MOV-19, player half)', () => {
  it('writes the same pose into a three.js object as animationPoseAt returns, at 50 pseudo-random times', () => {
    const base = spinDocument();
    const id = boxId(base);
    const doc = execute(base, 'animate', {
      targetId: id,
      mode: 'oscillate',
      amplitude: 0.8,
      frequency: 0.7,
      axis: [1, 1, 0],
      pivot: [5, -3, 2],
    }).document;
    const entity = doc.entities[id];
    const object = new THREE.Object3D();
    const pose = createAnimatedPose();
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 50; k += 1) {
      const t = random() * 4;
      const parts = Object.values(doc.animations).map((anim) => {
        const part = createContribution();
        fillAnimationContribution(part, anim, t, animationMembers(anim, doc.groups), doc.entities);
        return part;
      });
      composeAnimatedPoseInto(pose, entity?.position ?? [0, 0, 0], entity?.rotation ?? [0, 0, 0], parts);
      applyAnimatedPose(object, pose);
      const placement = animationPoseAt(doc, t)[id];
      for (let axis = 0; axis < 3; axis += 1)
        expect(Math.abs(object.position.getComponent(axis) - (placement?.position[axis] ?? NaN))).toBeLessThan(1e-12);
      const euler = new THREE.Euler().setFromQuaternion(object.quaternion, 'XYZ');
      expect(Math.abs(Math.sin((euler.z - (placement?.rotation[2] ?? NaN)) / 2))).toBeLessThan(1e-9);
      expect(Math.abs(Math.sin((euler.x - (placement?.rotation[0] ?? NaN)) / 2))).toBeLessThan(1e-9);
    }
  });
});
