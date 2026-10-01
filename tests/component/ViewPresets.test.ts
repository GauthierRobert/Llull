/**
 * View preset directions follow +Z-up CAD convention and never degenerate with camera.up=+Z.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PRESET_DIRECTIONS } from '@ui/viewport/3d/viewPresetDirections';

function viewBasis(name: keyof typeof PRESET_DIRECTIONS): {
  right: THREE.Vector3;
  up: THREE.Vector3;
} {
  const [x, y, z] = PRESET_DIRECTIONS[name];
  const camera = new THREE.PerspectiveCamera();
  camera.up.set(0, 0, 1);
  camera.position.set(x * 10, y * 10, z * 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  return {
    right: new THREE.Vector3(e[0], e[1], e[2]),
    up: new THREE.Vector3(e[4], e[5], e[6]),
  };
}

describe('PRESET_DIRECTIONS (+Z-up)', () => {
  it('front is eye at -Y, right is eye at +X, iso is (1,-1,1)', () => {
    expect(PRESET_DIRECTIONS.front).toEqual([0, -1, 0]);
    expect(PRESET_DIRECTIONS.right).toEqual([1, 0, 0]);
    expect(PRESET_DIRECTIONS.iso).toEqual([1, -1, 1]);
  });

  it('top is above +Z with a non-degenerate lookAt: screen right = +X, up = +Y', () => {
    expect(PRESET_DIRECTIONS.top[2]).toBeGreaterThan(0);
    const { right, up } = viewBasis('top');
    expect(right.x).toBeCloseTo(1, 3);
    expect(up.y).toBeCloseTo(1, 3);
  });

  it('front view reads XY-plane text right-side-up edge-on: screen right = +X, up = +Z', () => {
    const { right, up } = viewBasis('front');
    expect(right.x).toBeCloseTo(1, 6);
    expect(up.z).toBeCloseTo(1, 6);
  });

  it('iso view has +X component on screen right (text along +X reads left-to-right)', () => {
    expect(viewBasis('iso').right.x).toBeGreaterThan(0);
  });
});
