/**
 * Tests for composite.ts — make_tube_between command.
 *
 * Acceptance criterion: for every direction, applying the intrinsic XYZ Euler
 * rotation stored on the entity to the vector (0, 0, height/2) and adding the
 * midpoint should recover p2 within 1e-6 (and p1 similarly with -height/2).
 *
 * The applyEulerXYZ helper below mirrors render.ts exactly so the test validates
 * against the same convention the viewport uses.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

// ---------------------------------------------------------------------------
// Mirror of applyEulerXYZ from render.ts (intrinsic XYZ = Rz * Ry * Rx)
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

function applyEulerXYZ(v: Vec3, origin: Vec3, euler: Vec3): Vec3 {
  const [rx, ry, rz] = euler;
  let x = v[0] - origin[0];
  let y = v[1] - origin[1];
  let z = v[2] - origin[2];

  // Rx
  const cxr = Math.cos(rx),
    sxr = Math.sin(rx);
  const y1 = cxr * y - sxr * z;
  const z1 = sxr * y + cxr * z;
  y = y1;
  z = z1;

  // Ry
  const cyr = Math.cos(ry),
    syr = Math.sin(ry);
  const x2 = cyr * x + syr * z;
  const z2 = -syr * x + cyr * z;
  x = x2;
  z = z2;

  // Rz
  const czr = Math.cos(rz),
    szr = Math.sin(rz);
  const x3 = czr * x - szr * y;
  const y3 = szr * x + czr * y;
  x = x3;
  y = y3;

  return [x + origin[0], y + origin[1], z + origin[2]];
}

/**
 * Given a cylinder entity, compute the world-space tip of its +Z axis (the p2 end).
 * The entity is centered at its midpoint; the local +Z tip is at [0, 0, height/2]
 * before rotation, placed at the entity position in world space after rotation.
 */
function cylinderEndpoint(
  position: Vec3,
  rotation: Vec3,
  height: number,
): { p1End: Vec3; p2End: Vec3 } {
  const halfH = height / 2;
  // Local +Z tip → p2
  const p2End = applyEulerXYZ([0, 0, halfH], [0, 0, 0], rotation);
  const p2World: Vec3 = [position[0] + p2End[0], position[1] + p2End[1], position[2] + p2End[2]];
  // Local -Z tip → p1
  const p1End = applyEulerXYZ([0, 0, -halfH], [0, 0, 0], rotation);
  const p1World: Vec3 = [position[0] + p1End[0], position[1] + p1End[1], position[2] + p1End[2]];
  return { p1End: p1World, p2End: p2World };
}

function expectClose(actual: Vec3, expected: Vec3, eps = 1e-6, label = ''): void {
  const dx = Math.abs(actual[0] - expected[0]);
  const dy = Math.abs(actual[1] - expected[1]);
  const dz = Math.abs(actual[2] - expected[2]);
  const maxErr = Math.max(dx, dy, dz);
  expect(maxErr, `${label} max error ${maxErr} >= ${eps}`).toBeLessThan(eps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('make_tube_between', () => {
  /** Create the tube and return its endpoints as recovered from the stored transform. */
  function tubeEndpoints(
    p1: Vec3,
    p2: Vec3,
    radius: number,
  ): { e: { position: Vec3; rotation: Vec3; height: number }; p1End: Vec3; p2End: Vec3 } {
    const result = execute(createEmptyDocument(), 'make_tube_between', { p1, p2, radius });
    expect(result.affected).toHaveLength(1);
    const e = result.document.entities[result.affected[0]!] as {
      position: Vec3;
      rotation: Vec3;
      height: number;
    };
    return { e, ...cylinderEndpoint(e.position, e.rotation, e.height) };
  }

  // --- Happy paths: axis-aligned, diagonal and offset directions ---

  it.each<[string, Vec3, Vec3, number]>([
    ['axis +X', [0, 0, 0], [10, 0, 0], 1],
    ['axis -X', [5, 0, 0], [-5, 0, 0], 2],
    ['axis +Y', [0, 0, 0], [0, 7, 0], 1],
    ['axis -Y', [0, 3, 0], [0, -3, 0], 1],
    ['axis -Z (antiparallel edge case)', [0, 0, 4], [0, 0, -4], 1],
    ['diagonal XY plane', [0, 0, 0], [1, 1, 0], 0.5],
    ['diagonal XZ plane', [0, 0, 0], [1, 0, 1], 0.5],
    ['fully 3D', [0, 0, 0], [1, 1, 1], 0.25],
    ['non-origin start', [10, 20, 30], [13, 24, 30], 1],
  ])('%s: tube has correct endpoints', (label, p1, p2, radius) => {
    const { p1End, p2End } = tubeEndpoints(p1, p2, radius);
    expectClose(p1End, p1, 1e-6, `${label} p1`);
    expectClose(p2End, p2, 1e-6, `${label} p2`);
  });

  it('axis +Z: tube from [0,0,0] to [0,0,5] has correct endpoints (identity rotation)', () => {
    const { e, p1End, p2End } = tubeEndpoints([0, 0, 0], [0, 0, 5], 1);
    // rotation must be identity for +Z alignment
    for (const angle of e.rotation) expect(angle).toBeCloseTo(0, 9);
    expectClose(p1End, [0, 0, 0], 1e-6, '+Z p1');
    expectClose(p2End, [0, 0, 5], 1e-6, '+Z p2');
  });

  // --- Entity properties ---

  it('creates a cylinder entity with the given radius and color', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [0, 0, 10],
      radius: 3,
      color: '#ff0000',
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id]!;
    expect(e.kind).toBe('cylinder');
    expect((e as { radius: number }).radius).toBe(3);
    expect(e.color).toBe('#ff0000');
  });

  it('entity appears in document order', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [1, 0, 0],
      radius: 1,
    });
    const id = result.affected[0]!;
    expect(result.document.order).toContain(id);
  });

  it('summary includes both endpoints, radius, and length', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [0, 0, 10],
      radius: 2,
    });
    expect(result.summary).toContain('10.000');
    expect(result.summary).toContain('radius 2');
    expect(result.summary).toContain('0.000,0.000,0.000');
    expect(result.summary).toContain('0.000,0.000,10.000');
  });

  it('is pure — input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'make_tube_between', { p1: [0, 0, 0], p2: [1, 1, 1], radius: 1 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // --- Failure paths ---

  it.each<[string, Record<string, unknown>, string[]]>([
    ['radius <= 0', { p1: [0, 0, 0], p2: [1, 0, 0], radius: 0 }, ['radius', '0']],
    ['negative radius', { p1: [0, 0, 0], p2: [1, 0, 0], radius: -5 }, []],
    ['p1 === p2 (degenerate)', { p1: [3, 4, 5], p2: [3, 4, 5], radius: 1 }, ['same point']],
    ['non-array p1', { p1: 'not-an-array', p2: [1, 0, 0], radius: 1 }, ['p1']],
    ['non-array p2', { p1: [0, 0, 0], p2: null, radius: 1 }, []],
  ])('%s: no-op, affected:[], descriptive summary', (_label, params, summaryParts) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', params);
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    for (const part of summaryParts) expect(result.summary).toContain(part);
  });
});
