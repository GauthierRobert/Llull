/**
 * Unit tests for the BVH prototype-patch helper in `src/ui/viewport/3d/bvhSetup.ts`.
 *
 * Verifies:
 * - ensureBvhSetup() patches THREE.Mesh.prototype.raycast to acceleratedRaycast.
 * - ensureBvhSetup() adds computeBoundsTree / disposeBoundsTree to BufferGeometry.prototype.
 * - Calling ensureBvhSetup() twice is idempotent (no error, no double-application).
 * - computeBoundsTree() populates geometry.boundsTree on a real geometry.
 * - disposeBoundsTree() clears geometry.boundsTree.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { ensureBvhSetup, __resetBvhSetup } from '../../src/ui/viewport/3d/bvhSetup';

beforeEach(() => {
  // Reset idempotency flag and undo prototype mutations between tests so each test
  // starts from a clean baseline (mirrors how StrictMode might re-run effects).
  __resetBvhSetup();
  // Restore original prototypes before each test.
  delete (THREE.BufferGeometry.prototype as Partial<typeof THREE.BufferGeometry.prototype>).computeBoundsTree;
  delete (THREE.BufferGeometry.prototype as Partial<typeof THREE.BufferGeometry.prototype>).disposeBoundsTree;
  // Reset Mesh.prototype.raycast to the THREE.js default (object from prototype chain).
  // We can't easily restore the original function reference, so we verify against acceleratedRaycast after patching.
});

describe('ensureBvhSetup — prototype patch', () => {
  it('replaces THREE.Mesh.prototype.raycast with acceleratedRaycast', () => {
    ensureBvhSetup();
    expect(THREE.Mesh.prototype.raycast).toBe(acceleratedRaycast);
  });

  it('adds computeBoundsTree to THREE.BufferGeometry.prototype', () => {
    ensureBvhSetup();
    expect(THREE.BufferGeometry.prototype.computeBoundsTree).toBe(computeBoundsTree);
  });

  it('adds disposeBoundsTree to THREE.BufferGeometry.prototype', () => {
    ensureBvhSetup();
    expect(THREE.BufferGeometry.prototype.disposeBoundsTree).toBe(disposeBoundsTree);
  });
});

describe('ensureBvhSetup — idempotency', () => {
  it('calling twice does not throw and patch is still correct', () => {
    ensureBvhSetup();
    expect(() => ensureBvhSetup()).not.toThrow();
    // Patch remains correct after second call.
    expect(THREE.Mesh.prototype.raycast).toBe(acceleratedRaycast);
  });
});

describe('BVH lifecycle on a real geometry', () => {
  it('computeBoundsTree() populates boundsTree on a BoxGeometry', () => {
    ensureBvhSetup();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    expect(geo.boundsTree).toBeUndefined();
    geo.computeBoundsTree();
    expect(geo.boundsTree).toBeDefined();
    geo.disposeBoundsTree();
    geo.dispose();
  });

  it('disposeBoundsTree() clears boundsTree', () => {
    ensureBvhSetup();
    const geo = new THREE.BoxGeometry(2, 2, 2);
    geo.computeBoundsTree();
    expect(geo.boundsTree).toBeDefined();
    geo.disposeBoundsTree();
    // three-mesh-bvh sets boundsTree to null on dispose (not undefined).
    expect(geo.boundsTree).toBeNull();
    geo.dispose();
  });
});
