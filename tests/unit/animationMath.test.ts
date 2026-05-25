/**
 * Unit tests for animationMath.ts pure helpers.
 * No DOM, no React — pure math assertions.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  evaluateAnimationScalar,
  rotatePointAboutPivot,
  composeAnimatedPose,
} from '../../src/ui/viewport/3d/animationMath';

// ---------------------------------------------------------------------------
// evaluateAnimationScalar
// ---------------------------------------------------------------------------

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
    expect(
      evaluateAnimationScalar({ ...base, mode: 'oscillate' }, quarterPeriod),
    ).toBeCloseTo(base.amplitude);
  });

  it('oscillate: −amplitude at three-quarter period', () => {
    // phase = 3/(4*frequency): sin = −1 → value = −amplitude
    const threeQtrPeriod = 3 / (4 * base.frequency);
    expect(
      evaluateAnimationScalar({ ...base, mode: 'oscillate' }, threeQtrPeriod),
    ).toBeCloseTo(-base.amplitude);
  });
});

// ---------------------------------------------------------------------------
// rotatePointAboutPivot
// ---------------------------------------------------------------------------

describe('rotatePointAboutPivot', () => {
  it('rotates [1,0,0] by π about Y around origin → [−1,0,0]', () => {
    const point = new THREE.Vector3(1, 0, 0);
    const axis = new THREE.Vector3(0, 1, 0);
    const pivot = new THREE.Vector3(0, 0, 0);
    const result = rotatePointAboutPivot(point, axis, Math.PI, pivot);
    expect(result.x).toBeCloseTo(-1);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });

  it('rotates [2,0,0] by π about Y around [1,0,0] (pivot) → [0,0,0]', () => {
    // Relative to pivot: [1,0,0]. Rotate by π about Y → [−1,0,0]. Add pivot → [0,0,0].
    const point = new THREE.Vector3(2, 0, 0);
    const axis = new THREE.Vector3(0, 1, 0);
    const pivot = new THREE.Vector3(1, 0, 0);
    const result = rotatePointAboutPivot(point, axis, Math.PI, pivot);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });

  it('does not mutate input point', () => {
    const point = new THREE.Vector3(1, 0, 0);
    const axis = new THREE.Vector3(0, 1, 0);
    const pivot = new THREE.Vector3(0, 0, 0);
    rotatePointAboutPivot(point, axis, Math.PI / 2, pivot);
    expect(point.x).toBeCloseTo(1); // unchanged
  });

  it('zero angle leaves point unchanged', () => {
    const point = new THREE.Vector3(3, 4, 5);
    const result = rotatePointAboutPivot(
      point,
      new THREE.Vector3(0, 1, 0),
      0,
      new THREE.Vector3(1, 1, 1),
    );
    expect(result.x).toBeCloseTo(3);
    expect(result.y).toBeCloseTo(4);
    expect(result.z).toBeCloseTo(5);
  });
});

// ---------------------------------------------------------------------------
// composeAnimatedPose
// ---------------------------------------------------------------------------

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
    const { position, quaternion } = composeAnimatedPose([1, 0, 0], [0, 0, 0], [
      {
        channel: 'rotation',
        axis: new THREE.Vector3(0, 1, 0),
        scalar: Math.PI,
        pivot: new THREE.Vector3(0, 0, 0),
      },
    ]);
    expect(position[0]).toBeCloseTo(-1);
    expect(position[1]).toBeCloseTo(0);
    expect(position[2]).toBeCloseTo(0);
    // Quaternion encodes π rotation about Y: x=0, y=1, z=0 (normalised), w≈0
    expect(quaternion[1]).toBeCloseTo(1); // y component dominates
    expect(quaternion[3]).toBeCloseTo(0); // w ≈ 0
  });

  it('position contribution: translates along axis', () => {
    const { position } = composeAnimatedPose([0, 0, 0], [0, 0, 0], [
      {
        channel: 'position',
        axis: new THREE.Vector3(1, 0, 0),
        scalar: 5,
        pivot: new THREE.Vector3(0, 0, 0),
      },
    ]);
    expect(position[0]).toBeCloseTo(5);
    expect(position[1]).toBeCloseTo(0);
    expect(position[2]).toBeCloseTo(0);
  });

  it('two rotation contributions compose multiplicatively', () => {
    // Two quarter-turns about Z: net = half-turn about Z
    // [1,0,0] rotated π/2 about Z → [0,1,0], then another π/2 → [−1,0,0]
    const { position } = composeAnimatedPose([1, 0, 0], [0, 0, 0], [
      {
        channel: 'rotation',
        axis: new THREE.Vector3(0, 0, 1),
        scalar: Math.PI / 2,
        pivot: new THREE.Vector3(0, 0, 0),
      },
      {
        channel: 'rotation',
        axis: new THREE.Vector3(0, 0, 1),
        scalar: Math.PI / 2,
        pivot: new THREE.Vector3(0, 0, 0),
      },
    ]);
    expect(position[0]).toBeCloseTo(-1);
    expect(position[1]).toBeCloseTo(0);
    expect(position[2]).toBeCloseTo(0);
  });
});
