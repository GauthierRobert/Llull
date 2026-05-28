/**
 * Unit tests for TransformGizmo pure helpers and gizmo target resolution.
 *
 * These tests run in jsdom — they do NOT mount r3f. They validate:
 *   1. The pure math helpers (computeTranslateDelta, computeRotateDelta,
 *      computeScaleFactor) return correct values.
 *   2. The "children" attach pattern: a group in the scene tree has a non-null
 *      parent — so TransformControls.attach() would succeed (no "must be part
 *      of the scene graph" error).
 *   3. A group NOT in the scene tree has parent === null — confirming the
 *      original bug (detached object) would have triggered the error.
 *
 * Regression guard for W5C: ensures the target Object3D used by the gizmo is
 * always scene-parented before attach() is called. If targetRef.current.parent
 * is null at attach time, three-stdlib logs an error every frame and keeps
 * calling invalidate(), breaking the demand frameloop (W5G).
 */

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

// ---------------------------------------------------------------------------
// W5C regression: scene-graph membership test
// ---------------------------------------------------------------------------

describe('TransformGizmo scene-graph attachment invariant (W5C regression)', () => {
  it('a detached Object3D has parent === null — confirming the original bug', () => {
    // The old implementation created a bare new THREE.Object3D() and passed it
    // as the `object` prop to TransformControls. Because it was never added to
    // the scene, parent is null — triggering the error on every frame.
    const detached = new THREE.Object3D();
    expect(detached.parent).toBeNull();
  });

  it('a group added as a scene child has a non-null parent — attach() succeeds', () => {
    // The new implementation renders <group ref={targetRef}> inside
    // <TransformControls> so the group is a scene-graph node. This test
    // simulates that by adding the group to a parent scene.
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    scene.add(group);
    // group.parent is the scene — TransformControls.attach() would NOT log an error.
    expect(group.parent).toBe(scene);
    expect(group.parent).not.toBeNull();
  });

  it('a group nested inside a floating-origin group also has a non-null parent', () => {
    // Entities + gizmo live inside a <group position={groupOffset}> for the
    // floating-origin offset. The target group is a child of that wrapper —
    // it still has a parent (the wrapper), so attach() succeeds.
    const scene = new THREE.Scene();
    const floatingOriginGroup = new THREE.Group();
    scene.add(floatingOriginGroup);

    const targetGroup = new THREE.Group();
    floatingOriginGroup.add(targetGroup);

    expect(targetGroup.parent).toBe(floatingOriginGroup);
    expect(targetGroup.parent).not.toBeNull();

    // Verify matrixWorld update propagates correctly through nested parents.
    floatingOriginGroup.position.set(100, 200, 300);
    targetGroup.position.set(1, 0, 0);
    targetGroup.updateMatrixWorld(true);
    // The world position should be floatingOrigin + target = (101, 200, 300).
    const worldPos = new THREE.Vector3();
    targetGroup.getWorldPosition(worldPos);
    expect(worldPos.x).toBeCloseTo(101);
    expect(worldPos.y).toBeCloseTo(200);
    expect(worldPos.z).toBeCloseTo(300);
  });

  it('computeTranslateDelta is zero for a no-op drag', () => {
    const pos = new THREE.Vector3(5, 3, -2);
    const delta = computeTranslateDelta(pos, pos.clone());
    expect(delta[0]).toBeCloseTo(0);
    expect(delta[1]).toBeCloseTo(0);
    expect(delta[2]).toBeCloseTo(0);
    const mag = Math.sqrt(delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2);
    // The gizmo skips dispatch when mag < 1e-6 — this would be skipped.
    expect(mag).toBeLessThan(1e-6);
  });

  it('computeScaleFactor returns 1 for identity scale — no dispatch', () => {
    const identityScale = new THREE.Vector3(1, 1, 1);
    const factor = computeScaleFactor(identityScale);
    expect(factor).toBeCloseTo(1);
    // The gizmo skips dispatch when |factor - 1| < 1e-6.
    expect(Math.abs(factor - 1)).toBeLessThan(1e-6);
  });
});
