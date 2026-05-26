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

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

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
  const cxr = Math.cos(rx), sxr = Math.sin(rx);
  const y1 = cxr * y - sxr * z;
  const z1 = sxr * y + cxr * z;
  y = y1; z = z1;

  // Ry
  const cyr = Math.cos(ry), syr = Math.sin(ry);
  const x2 = cyr * x + syr * z;
  const z2 = -syr * x + cyr * z;
  x = x2; z = z2;

  // Rz
  const czr = Math.cos(rz), szr = Math.sin(rz);
  const x3 = czr * x - szr * y;
  const y3 = szr * x + czr * y;
  x = x3; y = y3;

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
  const p2World: Vec3 = [
    position[0] + p2End[0],
    position[1] + p2End[1],
    position[2] + p2End[2],
  ];
  // Local -Z tip → p1
  const p1End = applyEulerXYZ([0, 0, -halfH], [0, 0, 0], rotation);
  const p1World: Vec3 = [
    position[0] + p1End[0],
    position[1] + p1End[1],
    position[2] + p1End[2],
  ];
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
  beforeEach(() => __resetIdCounter());

  // --- Happy paths: axis-aligned directions ---

  it('axis +X: tube from [0,0,0] to [10,0,0] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [10, 0, 0],
      radius: 1,
    });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 0], 1e-6, '+X p1');
    expectClose(p2End, [10, 0, 0], 1e-6, '+X p2');
  });

  it('axis -X: tube from [5,0,0] to [-5,0,0] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [5, 0, 0],
      p2: [-5, 0, 0],
      radius: 2,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [5, 0, 0], 1e-6, '-X p1');
    expectClose(p2End, [-5, 0, 0], 1e-6, '-X p2');
  });

  it('axis +Y: tube from [0,0,0] to [0,7,0] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [0, 7, 0],
      radius: 1,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 0], 1e-6, '+Y p1');
    expectClose(p2End, [0, 7, 0], 1e-6, '+Y p2');
  });

  it('axis -Y: tube from [0,3,0] to [0,-3,0] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 3, 0],
      p2: [0, -3, 0],
      radius: 1,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 3, 0], 1e-6, '-Y p1');
    expectClose(p2End, [0, -3, 0], 1e-6, '-Y p2');
  });

  it('axis +Z: tube from [0,0,0] to [0,0,5] has correct endpoints (identity rotation)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [0, 0, 5],
      radius: 1,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    // rotation must be identity for +Z alignment
    expect(e.rotation[0]).toBeCloseTo(0, 9);
    expect(e.rotation[1]).toBeCloseTo(0, 9);
    expect(e.rotation[2]).toBeCloseTo(0, 9);
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 0], 1e-6, '+Z p1');
    expectClose(p2End, [0, 0, 5], 1e-6, '+Z p2');
  });

  it('axis -Z: tube from [0,0,4] to [0,0,-4] has correct endpoints (antiparallel edge case)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 4],
      p2: [0, 0, -4],
      radius: 1,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 4], 1e-6, '-Z p1');
    expectClose(p2End, [0, 0, -4], 1e-6, '-Z p2');
  });

  // --- Happy paths: diagonal directions ---

  it('diagonal XY plane: tube from [0,0,0] to [1,1,0] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [1, 1, 0],
      radius: 0.5,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 0], 1e-6, 'XY p1');
    expectClose(p2End, [1, 1, 0], 1e-6, 'XY p2');
  });

  it('diagonal XZ plane: tube from [0,0,0] to [1,0,1] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [1, 0, 1],
      radius: 0.5,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 0], 1e-6, 'XZ p1');
    expectClose(p2End, [1, 0, 1], 1e-6, 'XZ p2');
  });

  it('fully 3D: tube from [0,0,0] to [1,1,1] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [1, 1, 1],
      radius: 0.25,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [0, 0, 0], 1e-6, '3D p1');
    expectClose(p2End, [1, 1, 1], 1e-6, '3D p2');
  });

  it('non-origin start: tube from [10,20,30] to [13,24,30] has correct endpoints', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [10, 20, 30],
      p2: [13, 24, 30],
      radius: 1,
    });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as { position: Vec3; rotation: Vec3; height: number };
    const { p1End, p2End } = cylinderEndpoint(e.position, e.rotation, e.height);
    expectClose(p1End, [10, 20, 30], 1e-6, 'offset p1');
    expectClose(p2End, [13, 24, 30], 1e-6, 'offset p2');
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

  it('radius <= 0: no-op, affected:[], descriptive summary', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [1, 0, 0],
      radius: 0,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radius');
    expect(result.summary).toContain('0');
  });

  it('negative radius: no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [1, 0, 0],
      radius: -5,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('p1 === p2 (degenerate): no-op, affected:[], descriptive summary', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [3, 4, 5],
      p2: [3, 4, 5],
      radius: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('same point');
  });

  it('non-array p1: no-op, affected:[], descriptive summary', () => {
    const doc = createEmptyDocument();
    // Cast to any to simulate a bad agent call
    const result = execute(doc, 'make_tube_between', {
      p1: 'not-an-array' as unknown as [number, number, number],
      p2: [1, 0, 0],
      radius: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('p1');
  });

  it('non-array p2: no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'make_tube_between', {
      p1: [0, 0, 0],
      p2: null as unknown as [number, number, number],
      radius: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });
});
