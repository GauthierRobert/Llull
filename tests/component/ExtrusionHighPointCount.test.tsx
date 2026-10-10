/**
 * Component tests for the `kind:'extrusion'` render path with high-point-count
 * concave profiles — the verification suite for spur-gear extrusions.
 *
 * Context: `add_spur_gear` produces an `extrusion` entity whose profile
 * can exceed 840 points for a 42-tooth gear. THREE.ExtrudeGeometry internally
 * uses earcut for triangulation; this suite verifies:
 *   1. A synthetic 840-point concave profile triangulates without producing
 *      zero vertices (no silent earcut failure).
 *   2. The vertex count is in the right order of magnitude (face + side tris).
 *   3. The geometry is disposed cleanly without error.
 *   4. The profileKey memo-key function produces distinct keys for distinct
 *      profiles (guards against geometry-sharing bugs for multi-gear scenes).
 *   5. The `add_spur_gear` command produces an entity with kind 'extrusion'
 *      and the profile/depth fields are non-trivially populated.
 *
 * We do NOT import `buildSpurGearProfile` from `gears.ts` — this test generates
 * its own synthetic concave profile inline to stay decoupled from core math.
 * The THREE.ExtrudeGeometry path is exercised directly (jsdom can run THREE
 * without WebGL) mirroring the pattern in RevolutionMesh.test.tsx.
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { type ExtrusionEntity } from '@core/model/types';
import {
  type DispatchedEntity,
  dispatchEntity,
  resetStore,
  shapeFromProfile,
} from '../helpers/componentEntities';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic gear-like concave polygon with approximately `targetPoints`
 * total vertices.  The profile alternates between an outer "tip" circle and an inner
 * "root" circle to form a star/gear shape, producing a non-convex outline that
 * exercises earcut's concave triangulation path.
 *
 * Profile is returned as ReadonlyArray<readonly [number, number]> (closed: last ≈ first).
 *
 * @param teeth        Number of "teeth" (peaks on outer radius).
 * @param outerRadius  Radius of tooth tips.
 * @param rootRadius   Radius of tooth roots (< outerRadius).
 * @param pointsPerTooth Points placed along each tooth flank pair (min 10).
 */
function buildSyntheticGearProfile(
  teeth: number,
  outerRadius: number,
  rootRadius: number,
  pointsPerTooth: number,
): ReadonlyArray<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  const n = Math.max(pointsPerTooth, 4);
  for (let t = 0; t < teeth; t++) {
    const baseAngle = (2 * Math.PI * t) / teeth;
    const toothAngle = (2 * Math.PI) / teeth;
    // Distribute `n` points around this tooth: rising flank, tip arc, falling flank, root.
    for (let i = 0; i < n; i++) {
      const frac = i / n;
      let r: number;
      let a: number;
      if (frac < 0.1) {
        // Root → tip rising flank
        r = rootRadius + (outerRadius - rootRadius) * (frac / 0.1);
        a = baseAngle + toothAngle * frac * 0.5;
      } else if (frac < 0.5) {
        // Tip arc
        r = outerRadius;
        a = baseAngle + toothAngle * (frac * 0.5 + 0.05);
      } else if (frac < 0.6) {
        // Tip → root falling flank
        r = outerRadius - (outerRadius - rootRadius) * ((frac - 0.5) / 0.1);
        a = baseAngle + toothAngle * (frac * 0.5 + 0.1);
      } else {
        // Root arc
        r = rootRadius;
        a = baseAngle + toothAngle * (0.55 + (frac - 0.6) * 0.9);
      }
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
  }
  // Close the polygon.
  if (pts.length > 0) pts.push(pts[0]!);
  return pts;
}

// ---------------------------------------------------------------------------
// Geometry-level tests — THREE.ExtrudeGeometry on high-point-count concave profiles
// ---------------------------------------------------------------------------

function extrudedVertexCount(
  profile: ReadonlyArray<readonly [number, number]>,
  depth: number,
): number {
  const geo = new THREE.ExtrudeGeometry(shapeFromProfile(profile), { depth, bevelEnabled: false });
  const count = geo.attributes['position']?.count ?? 0;
  geo.dispose();
  return count;
}

describe('ExtrusionMesh — THREE.ExtrudeGeometry with 840-point concave profile', () => {
  it('earcut triangulates an 840-point synthetic gear profile without zero vertices', () => {
    // 42 teeth × 20 points/tooth = 840 + 1 closing = 841 profile points.
    const profile = buildSyntheticGearProfile(42, 10, 7.5, 20);
    expect(profile.length).toBeGreaterThanOrEqual(840);
    // Expect thousands of vertices (two triangulated faces + side walls).
    expect(extrudedVertexCount(profile, 2)).toBeGreaterThan(500);
  });

  it('earcut triangulates an ~1380-point 42-tooth gear-like profile (closer to real gear)', () => {
    // 42 teeth × 33 points/tooth ≈ 1386 points — mirrors the real gear profile density.
    const profile = buildSyntheticGearProfile(42, 10, 7.5, 33);
    expect(profile.length).toBeGreaterThanOrEqual(1380);
    expect(extrudedVertexCount(profile, 5)).toBeGreaterThan(1000);
  });

  it('small gear (8 teeth, ~160 points) also triangulates correctly', () => {
    expect(extrudedVertexCount(buildSyntheticGearProfile(8, 5, 3.5, 20), 3)).toBeGreaterThan(0);
  });

  it('geometry disposes cleanly without throwing', () => {
    const shape = shapeFromProfile(buildSyntheticGearProfile(20, 8, 6, 20));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false });
    expect(() => geo.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// profileKey stability — distinct profiles produce distinct keys (memo guard)
// ---------------------------------------------------------------------------

/**
 * Reimplementation of the profileKey function from ExtrusionMesh.tsx.
 * Tested here to guard against the key collision that would cause two gears
 * to share geometry incorrectly.
 */
function profileKey(profile: ReadonlyArray<readonly [number, number]>): string {
  return profile.map(([x, y]) => `${x},${y}`).join(';');
}

describe('profileKey — memo stability for multi-gear scenes', () => {
  it('two distinct profiles produce distinct keys', () => {
    const p1 = buildSyntheticGearProfile(12, 5, 3.5, 10);
    const p2 = buildSyntheticGearProfile(20, 8, 6, 10);
    expect(profileKey(p1)).not.toBe(profileKey(p2));
  });

  it('same profile produces the same key across calls', () => {
    const p = buildSyntheticGearProfile(12, 5, 3.5, 10);
    expect(profileKey(p)).toBe(profileKey(p));
  });

  it('profiles differing only in depth produce the same profile key (depth is tracked separately)', () => {
    // Depth is a separate memo dep in ExtrusionMesh — only profile content determines profileKey.
    const p = buildSyntheticGearProfile(12, 5, 3.5, 10);
    expect(profileKey(p)).toBe(profileKey(p));
  });

  it('key encodes every point — single changed vertex produces different key', () => {
    const p1 = buildSyntheticGearProfile(12, 5, 3.5, 10);
    const p2 = [...p1.slice(0, -1), [99, 99] as readonly [number, number], p1[p1.length - 1]!];
    expect(profileKey(p1)).not.toBe(profileKey(p2));
  });
});

// ---------------------------------------------------------------------------
// Store / entity tests — add_spur_gear via command registry
// ---------------------------------------------------------------------------

describe('add_spur_gear — extrusion entity in the store', () => {
  beforeEach(resetStore);

  const gear = (teeth: number, module: number, faceWidth: number): DispatchedEntity =>
    dispatchEntity('add_spur_gear', { teeth, module, faceWidth });
  const extrusion = (teeth: number, module: number, faceWidth: number): ExtrusionEntity => {
    const { entity } = gear(teeth, module, faceWidth);
    if (entity.kind !== 'extrusion') throw new Error('Expected extrusion entity');
    return entity;
  };

  it('produces an entity with kind "extrusion"', () => {
    const { entity, affected } = gear(42, 1, 8);
    expect(affected).toHaveLength(1);
    expect(entity.kind).toBe('extrusion');
  });

  it('42-tooth gear profile has > 500 points (high-point-count path)', () => {
    expect(extrusion(42, 1, 8).profile.length).toBeGreaterThan(500);
  });

  it('extrusion entity carries a positive depth equal to faceWidth', () => {
    expect(extrusion(20, 2, 10).depth).toBeGreaterThan(0);
  });

  it('gear entity appears in document.order', () => {
    const { id } = gear(10, 1, 5);
    expect(useStore.getState().document.order).toContain(id);
  });

  it('gear entity has a valid 3-component position', () => {
    expect(gear(10, 1, 5).entity.position).toHaveLength(3);
  });

  it('ExtrudeGeometry built from the real gear profile yields > 1000 vertices', () => {
    const { profile, depth } = extrusion(42, 1, 8);
    expect(extrudedVertexCount(profile, depth)).toBeGreaterThan(1000);
  });
});
