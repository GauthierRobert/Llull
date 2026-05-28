/**
 * Component tests for the `kind:'revolution'` 3D viewport render branch (VN2).
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
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';
import type { RevolutionEntity } from '@core/model/types';

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

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
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('revolve_profile produces an entity with kind "revolution"', () => {
    const result = localDispatch('revolve_profile', {
      profile: SQUARE_PROFILE,
      axis: [0, 0, 1],
      angle: Math.PI * 2,
      segments: 32,
    });
    expect(result.affected).toHaveLength(1);

    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId];
    expect(entity).toBeDefined();
    expect(entity?.kind).toBe('revolution');
  });

  it('revolution entity carries the correct profile, axis, angle, and segments', () => {
    const result = localDispatch('revolve_profile', {
      profile: SQUARE_PROFILE,
      axis: [0, 0, 1],
      angle: Math.PI,
      segments: 16,
    });
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId] as RevolutionEntity | undefined;
    if (!entity || entity.kind !== 'revolution') throw new Error('Expected revolution entity');

    expect(entity.profile).toEqual(SQUARE_PROFILE);
    expect(entity.axis).toEqual([0, 0, 1]);
    expect(entity.angle).toBeCloseTo(Math.PI, 5);
    expect(entity.segments).toBe(16);
  });

  it('revolution entity appears in document.order', () => {
    const result = localDispatch('revolve_profile', {
      profile: SQUARE_PROFILE,
      axis: [0, 0, 1],
      angle: Math.PI * 2,
      segments: 32,
    });
    const entityId = result.affected[0]!;
    expect(useStore.getState().document.order).toContain(entityId);
  });

  it('revolution entity has a valid position (length 3)', () => {
    const result = localDispatch('revolve_profile', {
      profile: SQUARE_PROFILE,
      axis: [0, 1, 0],
      angle: Math.PI * 2,
      segments: 24,
    });
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId];
    expect(entity?.position).toHaveLength(3);
  });

  it('partial revolution (angle=PI) creates a revolution entity', () => {
    const result = localDispatch('revolve_profile', {
      profile: SQUARE_PROFILE,
      axis: [1, 0, 0],
      angle: Math.PI,
      segments: 12,
    });
    expect(result.affected).toHaveLength(1);
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId];
    expect(entity?.kind).toBe('revolution');
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
