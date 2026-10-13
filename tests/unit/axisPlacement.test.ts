import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { eulerFromAxis, eulerFromMat, matFromEulerXYZ } from '@lib/axisRotation';
import { expectNoOp } from '../helpers/expectNoOp';
import { xy } from '../helpers/xy';

const empty = (): CadDocument => createEmptyDocument();

function extent(doc: CadDocument, id: string): Vec3 {
  const b = rotatedEntityBounds(doc.entities[id]!);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

describe('eulerFromAxis', () => {
  it('maps local +Z onto the requested direction (round trip through applyEulerXYZ)', () => {
    const dirs: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
      [1, 1, 1],
      [-2, 0.5, 0.3],
      [0, 0, 1],
    ];
    for (const d of dirs) {
      const euler = eulerFromAxis(d, 0.7)!;
      const len = Math.hypot(...d);
      const out = applyEulerXYZ([0, 0, 1], [0, 0, 0], euler);
      expect(out[0]).toBeCloseTo(d[0] / len, 6);
      expect(out[1]).toBeCloseTo(d[1] / len, 6);
      expect(out[2]).toBeCloseTo(d[2] / len, 6);
    }
  });
  it('rejects zero or malformed axes and round-trips matrix <-> euler', () => {
    expect(eulerFromAxis([0, 0, 0])).toBeNull();
    expect(eulerFromAxis([1, 2])).toBeNull();
    expect(eulerFromAxis([NaN, 0, 1])).toBeNull();
    const e: Vec3 = [0.3, -0.4, 1.1];
    const back = eulerFromMat(matFromEulerXYZ(e));
    expect(back[0]).toBeCloseTo(0.3);
    expect(back[1]).toBeCloseTo(-0.4);
    expect(back[2]).toBeCloseTo(1.1);
    const lock = eulerFromMat(matFromEulerXYZ([0.2, Math.PI / 2, 0]));
    expect(lock[1]).toBeCloseTo(Math.PI / 2);
  });
});

describe('axis param on primitives', () => {
  it('cylinder with axis [1,0,0] is elongated along X', () => {
    const r = execute(empty(), 'add_cylinder', { radius: 1, height: 10, axis: [1, 0, 0] });
    const [ex, ey, ez] = extent(r.document, r.affected[0]!);
    expect(ex).toBeCloseTo(10);
    expect(ey).toBeCloseTo(2);
    expect(ez).toBeCloseTo(2);
  });
  it('cylinder with axis [cos t, sin t, 0] matches the radial hand-derived rotation', () => {
    const t = 0.6;
    const r = execute(empty(), 'add_cylinder', { radius: 1, height: 10, axis: [Math.cos(t), Math.sin(t), 0] });
    const e = r.document.entities[r.affected[0]!]!;
    const dir = applyEulerXYZ([0, 0, 1], [0, 0, 0], e.rotation);
    expect(dir[0]).toBeCloseTo(Math.cos(t));
    expect(dir[1]).toBeCloseTo(Math.sin(t));
    expect(dir[2]).toBeCloseTo(0);
    const hand = applyEulerXYZ([0, 0, 1], [0, 0, 0], [-Math.PI / 2, Math.PI / 2 - t, 0]);
    expect(hand[0]).toBeCloseTo(dir[0]);
    expect(hand[1]).toBeCloseTo(dir[1]);
    expect(hand[2]).toBeCloseTo(dir[2]);
  });
  it('axis overrides rotation', () => {
    const r = execute(empty(), 'add_cylinder', { radius: 1, height: 10, rotation: [0, Math.PI / 2, 0.3], axis: [0, 1, 0] });
    const [ex, ey] = extent(r.document, r.affected[0]!);
    expect(ey).toBeCloseTo(10);
    expect(ex).toBeCloseTo(2);
  });
  it('cone and torus accept axis', () => {
    const cone = execute(empty(), 'add_cone', { radius: 1, height: 6, axis: [0, 1, 0] });
    expect(extent(cone.document, cone.affected[0]!)[1]).toBeCloseTo(6);
    const torus = execute(empty(), 'add_torus', { ringRadius: 5, tubeRadius: 1, axis: [1, 0, 0] });
    const [ex, ey, ez] = extent(torus.document, torus.affected[0]!);
    expect(ex).toBeCloseTo(2);
    expect(ey).toBeCloseTo(12);
    expect(ez).toBeCloseTo(12);
  });
  it('extrude_profile extrudes along axis', () => {
    const r = execute(empty(), 'extrude_profile', { profile: xy(0, 0, 2, 0, 2, 2, 0, 2), depth: 8, axis: [1, 0, 0] });
    const [ex, ey, ez] = extent(r.document, r.affected[0]!);
    expect(ex).toBeCloseTo(8);
    expect(ey).toBeCloseTo(2);
    expect(ez).toBeCloseTo(2);
  });
  it('zero-length axis is a no-op with a summary', () => {
    for (const [name, params] of [
      ['add_cylinder', { radius: 1, height: 2, axis: [0, 0, 0] }],
      ['extrude_profile', { profile: xy(0, 0, 1, 0, 1, 1), depth: 1, axis: [0, 0, 0] }],
    ] as const) {
      const doc = empty();
      const r = execute(doc, name, params);
      expectNoOp(r, doc);
      expect(r.summary).toMatch(/axis/);
    }
  });
});

describe('array_polar axis', () => {
  it('7x polar array of a radially oriented cylinder keeps its radial orientation', () => {
    const base = execute(empty(), 'add_cylinder', { radius: 1, height: 4, position: [10, 0, 0], axis: [1, 0, 0] });
    const id = base.affected[0]!;
    const r = execute(base.document, 'array_polar', { id, count: 7, center: [0, 0, 0] });
    expect(r.affected).toHaveLength(6);
    r.affected.forEach((copyId, i) => {
      const theta = ((i + 1) * 2 * Math.PI) / 7;
      const copy = r.document.entities[copyId]!;
      expect(copy.position[0]).toBeCloseTo(10 * Math.cos(theta));
      expect(copy.position[1]).toBeCloseTo(10 * Math.sin(theta));
      const dir = applyEulerXYZ([0, 0, 1], [0, 0, 0], copy.rotation);
      expect(dir[0]).toBeCloseTo(Math.cos(theta));
      expect(dir[1]).toBeCloseTo(Math.sin(theta));
      expect(dir[2]).toBeCloseTo(0);
    });
  });
  it('array about the X axis orbits position and orientation', () => {
    const base = execute(empty(), 'add_cylinder', { radius: 1, height: 4, position: [0, 5, 0], axis: [0, 1, 0] });
    const id = base.affected[0]!;
    const r = execute(base.document, 'array_polar', { id, count: 4, center: [0, 0, 0], axis: [1, 0, 0] });
    const quarter = r.document.entities[r.affected[0]!]!;
    expect(quarter.position[1]).toBeCloseTo(0);
    expect(quarter.position[2]).toBeCloseTo(5);
    const dir = applyEulerXYZ([0, 0, 1], [0, 0, 0], quarter.rotation);
    expect(dir[1]).toBeCloseTo(0);
    expect(dir[2]).toBeCloseTo(1);
    expect(r.summary).toContain('[1, 0, 0]');
  });
  it('center offsets the axis line; invalid axis or count is a no-op', () => {
    const base = execute(empty(), 'add_box', { size: [1, 1, 1], position: [3, 0, 0] });
    const id = base.affected[0]!;
    const shifted = execute(base.document, 'array_polar', { id, count: 2, center: [1, 0, 7], axis: [0, 0, 1] });
    expect(shifted.document.entities[shifted.affected[0]!]!.position[0]).toBeCloseTo(-1);
    const bad = execute(base.document, 'array_polar', { id, count: 3, center: [0, 0, 0], axis: [0, 0, 0] });
    expectNoOp(bad, base.document);
    expect(bad.summary).toMatch(/axis/);
  });
});
