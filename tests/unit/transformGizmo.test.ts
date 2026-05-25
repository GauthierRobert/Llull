import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeTranslateDelta,
  computeRotateDelta,
  computeScaleFactor,
} from '@ui/viewport/3d/TransformGizmo';

describe('TransformGizmo pure delta helpers', () => {
  it('computeTranslateDelta returns the signed component difference (next - prev)', () => {
    const delta = computeTranslateDelta(new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 0, -1));
    expect(delta).toEqual([3, -2, -4]);
  });

  it('computeRotateDelta returns the signed Euler difference in radians', () => {
    const delta = computeRotateDelta(new THREE.Euler(0, 0.5, 1), new THREE.Euler(0.25, 0.5, 0));
    expect(delta[0]).toBeCloseTo(0.25);
    expect(delta[1]).toBeCloseTo(0);
    expect(delta[2]).toBeCloseTo(-1);
  });

  it('computeScaleFactor is the arithmetic mean of the three axes (uniform projection)', () => {
    expect(computeScaleFactor(new THREE.Vector3(2, 2, 2))).toBeCloseTo(2);
    // Single-axis drag is a deliberate lossy projection onto the uniform contract.
    expect(computeScaleFactor(new THREE.Vector3(2, 1, 1))).toBeCloseTo(4 / 3);
  });
});
