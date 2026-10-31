/**
 * DES-6c (06 BLD §13.34): two legs (`size2`) on curved edges, curved faces and with legs that run along the edge, on the native OCCT kernel. The removed volumes are
 * compared with integrals the test computes itself (the section revolved about the axis by Green's theorem, or the section area integrated along the edge); check_blends
 * reads both legs back (`data.legs`) and reports no radius for a leg pair. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
interface LegRow {
  readonly op: string;
  readonly edge: number;
  readonly face: number | null;
  readonly requested: { readonly first: readonly [number, number]; readonly second: readonly [number, number] };
  readonly legs: ReadonlyArray<{ readonly s: number; readonly first: number; readonly second: number }>;
  readonly maxDeviation: number | null;
  readonly note?: string;
}
interface Checked {
  readonly status: string;
  readonly blends: ReadonlyArray<{
    readonly radius?: unknown;
    readonly lawChecked?: boolean;
    readonly contacts: ReadonlyArray<{ readonly g1AngleRad: number }>;
  }>;
  readonly legs?: readonly LegRow[];
  readonly findings: ReadonlyArray<{ code: string; severity: string }>;
  readonly unverified: number;
}

/** 2 pi |closed integral of rho^2 / 2 dz| over the closed polygon `points` (rho, z): the volume of its revolution. */
function revolved(points: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  points.forEach((p, k) => {
    const q = points[(k + 1) % points.length] as readonly [number, number];
    sum += ((p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) / 6) * (q[1] - p[1]);
  });
  return 2 * Math.PI * Math.abs(sum);
}

/** The rational quadratic a, t, b of weight w sampled at n + 1 points. */
function conic(
  a: readonly [number, number],
  t: readonly [number, number],
  b: readonly [number, number],
  w: number,
  n = 20000,
): Array<[number, number]> {
  return Array.from({ length: n + 1 }, (_, k) => {
    const u = k / n;
    const basis = [(1 - u) * (1 - u), 2 * u * (1 - u) * w, u * u] as const;
    const norm = basis[0] + basis[1] + basis[2];
    return [(basis[0] * a[0] + basis[1] * t[0] + basis[2] * b[0]) / norm, (basis[0] * a[1] + basis[1] * t[1] + basis[2] * b[1]) / norm];
  });
}

describeNative('DES-6c 13.34: two legs on curved edges, curved faces and running legs (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const made = (
    doc: Doc,
    command: string,
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const check = (doc: Doc, id: string): Checked => execute(doc, 'check_blends', { ids: [id] }).data as Checked;
  const cylinder = (radius: number, height: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'add_cylinder', { radius, height, anchor: 'base-center' });

  it('a cylinder rim with legs 1 (top) x 3 (side) removes the revolved conic spandrel, in either section, and check_blends reads both legs and no radius', () => {
    const rim = cylinder(10, 20);
    for (const [profile, weight] of [
      [{ type: 'conic', rho: 0.5 }, 1],
      [{ type: 'circular' }, Math.SQRT1_2],
    ] as const) {
      const done = made(rim.doc, 'fillet_edge', {
        id: rim.id,
        edges: [{ near: [10, 0, 20], size: 1, size2: 3, side1Near: [0, 0, 20] }],
        profile,
      });
      expect(done.result.error).toBeUndefined();
      // circular: the tangent lines of a right angle meet at the corner, the weight is sin 45 degrees
      const outline: Array<readonly [number, number]> = [[10, 20], ...conic([9, 20], [10, 20], [10, 17], weight)];
      const expected = revolved(outline);
      expect(Math.abs(volume(rim.doc, rim.id) - volume(done.doc, done.id) - expected)).toBeLessThan(1e-6 * expected);
      const checked = check(done.doc, done.id);
      expect(checked.status).toBe('pass');
      expect(checked.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
      expect(checked.blends[0]?.radius).toBeUndefined();
      const [row] = checked.legs ?? [];
      expect(checked.legs).toHaveLength(1);
      expect(row).toMatchObject({ op: 'fillet', requested: { first: [1, 1], second: [3, 3] } });
      expect(row?.maxDeviation).toBeLessThan(1e-3);
      expect(row?.legs[0]).toMatchObject({ first: expect.closeTo(1, 3), second: expect.closeTo(3, 3) });
    }
  });

  it('the legs follow the faces they are named on: side1 on the cylinder swaps the two legs', () => {
    const rim = cylinder(10, 20);
    const on = (side1Near: [number, number, number]): { doc: Doc; id: string; result: ReturnType<typeof execute> } =>
      made(rim.doc, 'fillet_edge', {
        id: rim.id,
        edges: [{ near: [10, 0, 20], size: 1, size2: 3, side1Near }],
        profile: { type: 'conic', rho: 0.5 },
      });
    const top = on([0, 0, 20]);
    const side = on([10, 0, 10]);
    const removed = (done: { doc: Doc; id: string }): number => volume(rim.doc, rim.id) - volume(done.doc, done.id);
    expect(Math.abs(removed(top) - revolved([[10, 20], ...conic([9, 20], [10, 20], [10, 17], 1)]))).toBeLessThan(1e-4);
    expect(Math.abs(removed(side) - revolved([[10, 20], ...conic([7, 20], [10, 20], [10, 19], 1)]))).toBeLessThan(1e-4);
    expect(removed(top)).not.toBeCloseTo(removed(side), 2);
  });

  it('a boss foot (concave, plane + cylinder) with legs 1.5 on the plate and 3 on the boss adds the revolved spandrel', () => {
    const plate = made(createEmptyDocument(), 'add_box', { size: [60, 60, 5], anchor: 'center' });
    const boss = made(plate.doc, 'add_cylinder', { radius: 5, height: 10, anchor: 'base-center' });
    const joined = made(boss.doc, 'boolean', { op: 'union', a: plate.id, b: boss.id });
    expect(joined.result.error).toBeUndefined();
    const top = 2.5;
    const done = made(joined.doc, 'fillet_edge', {
      id: joined.id,
      edges: [{ near: [5, 0, top], size: 1.5, size2: 3, side1Near: [20, 0, top] }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    const added = volume(done.doc, done.id) - volume(joined.doc, joined.id);
    const expected = revolved([[5, top], ...conic([6.5, top], [5, top], [5, top + 3], 1)]);
    expect(Math.abs(added - expected)).toBeLessThan(1e-6 * expected);
    expect(check(done.doc, done.id).status).toBe('pass');
  });

  it('legs that run (1 -> 2 on the top, 2 -> 3 on the front) along a straight edge remove the integral of the section area, and are read back along the edge', () => {
    const block = made(createEmptyDocument(), 'add_box', { size: [20, 10, 5], anchor: 'min' });
    const done = made(block.doc, 'fillet_edge', {
      id: block.id,
      edges: [{ near: [10, 5, 5], size: 1, sizeEnd: 2, size2: 2, size2End: 3, side1Near: [10, 5, 5] }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    // a parabola: the section is a third of the triangle between its tangents, d1 d2 / 6; integral of (1 + x)(2 + x) over x in [0, 1] = 23 / 6, times L / 6
    const expected = (20 / 6) * (23 / 6);
    expect(Math.abs(volume(block.doc, block.id) - volume(done.doc, done.id) - expected)).toBeLessThan(1e-6 * expected);
    expect(done.result.summary).toContain('1>2 x 2>3');
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    const [row] = checked.legs ?? [];
    expect(row?.requested).toEqual({ first: [1, 2], second: [2, 3] });
    expect(row?.legs).toHaveLength(21);
    expect(row?.maxDeviation).toBeLessThan(1e-6);
    expect(row?.legs[20]).toMatchObject({ s: 1, first: expect.closeTo(2, 6), second: expect.closeTo(3, 6) });
    // only the second leg runs: the first stays 1
    const second = made(block.doc, 'fillet_edge', {
      id: block.id,
      edges: [{ near: [10, 5, 5], size: 1, size2: 2, size2End: 3, side1Near: [10, 5, 5] }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(second.result.error).toBeUndefined();
    expect(check(second.doc, second.id).legs?.[0]?.requested).toEqual({ first: [1, 1], second: [2, 3] });
  });

  it('a leg pair running along an arc (half cylinder rim) is read back within the polyline of the contact line', () => {
    const cyl = made(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 10, anchor: 'base-center' });
    const slab = made(cyl.doc, 'add_box', { size: [50, 25, 12], anchor: 'min', position: [-25, 0, -1] });
    const half = made(slab.doc, 'boolean', { op: 'intersect', a: cyl.id, b: slab.id });
    expect(half.result.error).toBeUndefined();
    const done = made(half.doc, 'fillet_edge', {
      id: half.id,
      edges: [{ near: [0, 20, 10], size: 1, sizeEnd: 2, size2: 2, size2End: 3, side1Near: [0, 10, 10] }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    // V = integral (R A - M_x) d theta over the half circle with A = d1 d2 / 6 and M_x = d1^2 d2 / 30 (the parabola's first moment about the wall)
    const steps = 4000;
    let expected = 0;
    for (let k = 0; k <= steps; k++) {
      const s = k / steps;
      const [d1, d2] = [1 + s, 2 + s];
      expected += (k === 0 || k === steps ? 0.5 : 1) * ((20 * (d1 * d2)) / 6 - (d1 * d1 * d2) / 30);
    }
    expected *= Math.PI / steps;
    expect(Math.abs(volume(half.doc, half.id) - volume(done.doc, done.id) - expected)).toBeLessThan(5e-5 * expected);
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    expect(checked.legs?.[0]?.maxDeviation).toBeLessThan(1e-3);
    for (const blend of checked.blends) for (const contact of blend.contacts) expect(contact.g1AngleRad).toBeLessThan(1e-4);
  });

  it('refuses by name, with the measured reason: running legs on a closed rim, a leg past its face, edges at a vertex', () => {
    const rim = cylinder(10, 20);
    const refuse = (edges: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, target = rim): ReturnType<typeof execute> =>
      execute(target.doc, 'fillet_edge', { id: target.id, edges, ...extra });
    // a rim has no start and end for a running leg: the law check says so before the kernel is asked
    const closed = refuse([{ near: [10, 0, 20], size: 1, sizeEnd: 2, size2: 2, side1Near: [0, 0, 20] }]);
    expect(closed.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC' });
    const closedSecond = refuse([{ near: [10, 0, 20], size: 1, size2: 2, size2End: 3, side1Near: [0, 0, 20] }]);
    expect(closedSecond.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', paths: ['edges[0].size2End'] });
    const past = refuse([{ near: [10, 0, 20], size: 25, size2: 1, side1Near: [0, 0, 20] }]);
    expect(past.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(past.summary).toContain('reaches past');
    const block = made(createEmptyDocument(), 'add_box', { size: [20, 10, 5], anchor: 'min' });
    const atVertex = refuse(
      [
        { near: [10, 5, 5], size: 1, size2: 2, side1Near: [10, 5, 5] },
        { near: [0, 5, 2.5], size: 1, size2: 2, side1Near: [0, 5, 2.5] },
      ],
      {},
      block,
    );
    expect(atVertex.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(atVertex.document).toBe(block.doc);
  });
});
