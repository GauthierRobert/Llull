/**
 * Component tests for the `kind:'revolution'` 3D viewport render branch.
 *
 * We cannot run WebGL in jsdom, so we verify observable behavior via the store:
 *   1. `revolve_profile` produces an entity with `kind:'revolution'` in the document.
 *   2. The entity carries the profile, axis, angle, and segments from the command.
 *   3. The entity appears in `document.order` (EntityRenderer branch is not null).
 *
 * Additionally, we unit-test the geometry-building path by instantiating
 * THREE.LatheGeometry directly with a valid profile and asserting vertex count > 0,
 * mirroring what RevolutionMesh.tsx does at render time.
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { type RevolutionEntity } from '@core/model/types';
import { type DispatchedEntity, dispatchEntity, resetStore } from '../helpers/componentEntities';

// A simple closed square profile in the radial half-plane:
// [radialOffset, axialOffset] — must have r >= 0 to avoid inside-out geometry.
const SQUARE_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [2, 0],
  [2, 3],
  [1, 3],
];

// ---------------------------------------------------------------------------
// Store-level tests — verify the command produces the right entity
// ---------------------------------------------------------------------------

describe('RevolutionMesh — revolve_profile command → kind "revolution"', () => {
  beforeEach(resetStore);

  const revolve = (
    axis: [number, number, number],
    angle: number,
    segments: number,
  ): DispatchedEntity =>
    dispatchEntity('revolve_profile', { profile: SQUARE_PROFILE, axis, angle, segments });

  it('revolve_profile produces an entity with kind "revolution"', () => {
    const { entity, affected } = revolve([0, 0, 1], Math.PI * 2, 32);
    expect(affected).toHaveLength(1);
    expect(entity.kind).toBe('revolution');
  });

  it('revolution entity carries the correct profile, axis, angle, and segments', () => {
    const entity = revolve([0, 0, 1], Math.PI, 16).entity as RevolutionEntity;
    expect(entity.kind).toBe('revolution');
    expect(entity.profile).toEqual(SQUARE_PROFILE);
    expect(entity.axis).toEqual([0, 0, 1]);
    expect(entity.angle).toBeCloseTo(Math.PI, 5);
    expect(entity.segments).toBe(16);
  });

  it('revolution entity appears in document.order', () => {
    const { id } = revolve([0, 0, 1], Math.PI * 2, 32);
    expect(useStore.getState().document.order).toContain(id);
  });

  it('revolution entity has a valid position (length 3)', () => {
    expect(revolve([0, 1, 0], Math.PI * 2, 24).entity.position).toHaveLength(3);
  });

  it('partial revolution (angle=PI) creates a revolution entity', () => {
    const { entity, affected } = revolve([1, 0, 0], Math.PI, 12);
    expect(affected).toHaveLength(1);
    expect(entity.kind).toBe('revolution');
  });
});

// ---------------------------------------------------------------------------
// Geometry-level tests — LatheGeometry vertex count > 0
// (mirrors what RevolutionMesh builds; jsdom can run THREE without WebGL)
// ---------------------------------------------------------------------------

describe('RevolutionMesh — THREE.LatheGeometry vertex count', () => {
  it('full revolution (2π) with 4-point profile and 32 segments produces vertices', () => {
    const points = SQUARE_PROFILE.map(([r, a]) => new THREE.Vector2(Math.max(0, r), a));
    const geo = new THREE.LatheGeometry(points, 32, 0, Math.PI * 2);
    const count = geo.attributes.position?.count ?? 0;
    expect(count).toBeGreaterThan(0);
    geo.dispose();
  });

  it('partial revolution (π) produces vertices', () => {
    const points = SQUARE_PROFILE.map(([r, a]) => new THREE.Vector2(Math.max(0, r), a));
    const geo = new THREE.LatheGeometry(points, 16, 0, Math.PI);
    const count = geo.attributes.position?.count ?? 0;
    expect(count).toBeGreaterThan(0);
    geo.dispose();
  });

  it('minimum profile (2 points) produces vertices for a disk-like solid', () => {
    const points = [new THREE.Vector2(0, 0), new THREE.Vector2(2, 0)];
    const geo = new THREE.LatheGeometry(points, 8, 0, Math.PI * 2);
    const count = geo.attributes.position?.count ?? 0;
    expect(count).toBeGreaterThan(0);
    geo.dispose();
  });
});
