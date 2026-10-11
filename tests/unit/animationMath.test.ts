/**
 * Unit tests for animationMath.ts pure helpers.
 * No DOM, no React — pure math assertions.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  evaluateAnimationScalar,
  composeAnimatedPoseInto,
  createPoseScratch,
  type AnimationContribution,
} from '../../src/ui/viewport/3d/animationMath';

/** Tuple-returning wrapper over the allocation-free `composeAnimatedPoseInto`. */
function composeAnimatedPose(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  contributions: ReadonlyArray<AnimationContribution>,
): {
  position: [number, number, number];
  quaternion: [number, number, number, number];
} {
  const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  composeAnimatedPoseInto(pose, basePosition, baseRotation, contributions, createPoseScratch());
  const { position: p, quaternion: q } = pose;
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
}

// evaluateAnimationScalar

describe('evaluateAnimationScalar', () => {
  const base = { speed: 2, amplitude: 3, frequency: 0.5 };

  it('spin: returns speed * phase (linear in time)', () => {
    expect(evaluateAnimationScalar({ ...base, mode: 'spin' }, 0)).toBeCloseTo(0);
    expect(evaluateAnimationScalar({ ...base, mode: 'spin' }, 1)).toBeCloseTo(2);
    expect(evaluateAnimationScalar({ ...base, mode: 'spin' }, 2.5)).toBeCloseTo(5);
  });

  it('oscillate: zero at phase=0', () => {
    expect(evaluateAnimationScalar({ ...base, mode: 'oscillate' }, 0)).toBeCloseTo(0);
  });

  it('oscillate: amplitude at quarter period (phase = 1/(4*frequency))', () => {
    // frequency=0.5 Hz → period=2s → quarter period = 0.5s
    // sin(2π * 0.5 * 0.5) = sin(π/2) = 1  → amplitude * 1
    const quarterPeriod = 1 / (4 * base.frequency);
    expect(evaluateAnimationScalar({ ...base, mode: 'oscillate' }, quarterPeriod)).toBeCloseTo(
      base.amplitude,
    );
  });

  it('oscillate: −amplitude at three-quarter period', () => {
    // phase = 3/(4*frequency): sin = −1 → value = −amplitude
    const threeQtrPeriod = 3 / (4 * base.frequency);
    expect(evaluateAnimationScalar({ ...base, mode: 'oscillate' }, threeQtrPeriod)).toBeCloseTo(
      -base.amplitude,
    );
  });
});

// composeAnimatedPose

const contribution = (
  channel: 'rotation' | 'position',
  axis: [number, number, number],
  scalar: number,
): AnimationContribution => ({
  channel,
  axis: new THREE.Vector3(...axis),
  scalar,
  pivot: new THREE.Vector3(0, 0, 0),
});

function expectPosition(position: ArrayLike<number>, expected: number[]): void {
  expected.forEach((value, axis) => expect(position[axis]).toBeCloseTo(value));
}

describe('composeAnimatedPose', () => {
  it('no contributions → base pose unchanged', () => {
    const { position, quaternion } = composeAnimatedPose([1, 2, 3], [0, 0, 0], []);
    expect(position).toEqual([1, 2, 3]);
    // identity quaternion
    expect(quaternion[3]).toBeCloseTo(1); // w ≈ 1
    expect(quaternion[0]).toBeCloseTo(0);
    expect(quaternion[1]).toBeCloseTo(0);
    expect(quaternion[2]).toBeCloseTo(0);
  });

  it('rotation contribution: position is rotated around pivot', () => {
    // Entity at [1,0,0]; pivot at origin; rotate π about Y → position becomes [−1,0,0]
    const { position, quaternion } = composeAnimatedPose(
      [1, 0, 0],
      [0, 0, 0],
      [contribution('rotation', [0, 1, 0], Math.PI)],
    );
    expectPosition(position, [-1, 0, 0]);
    // Quaternion encodes π rotation about Y: x=0, y=1, z=0 (normalised), w≈0
    expect(quaternion[1]).toBeCloseTo(1); // y component dominates
    expect(quaternion[3]).toBeCloseTo(0); // w ≈ 0
  });

  it('position contribution: translates along axis', () => {
    const { position } = composeAnimatedPose(
      [0, 0, 0],
      [0, 0, 0],
      [contribution('position', [1, 0, 0], 5)],
    );
    expectPosition(position, [5, 0, 0]);
  });

  it('two rotation contributions compose multiplicatively', () => {
    // Two quarter-turns about Z: net = half-turn about Z
    // [1,0,0] rotated π/2 about Z → [0,1,0], then another π/2 → [−1,0,0]
    const { position } = composeAnimatedPose(
      [1, 0, 0],
      [0, 0, 0],
      [
        contribution('rotation', [0, 0, 1], Math.PI / 2),
        contribution('rotation', [0, 0, 1], Math.PI / 2),
      ],
    );
    expectPosition(position, [-1, 0, 0]);
  });
});
