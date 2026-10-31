/**
 * BLD M5 (docs/design/06-variable-blends 13.32): the joints of `blend_union` picked by persistent name and given radius laws, on the native OCCT kernel against
 * closed forms and numeric integrals. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { crossedCylindersFilletVolume } from './filletOracle';

type Doc = CadDocument;
const SIZES = [1, 10, 100, 1000] as const;
/** Area a concave right-angle fillet of radius 1 adds to the section: 1 - pi / 4. */
const CORNER = 1 - Math.PI / 4;

interface JointData {
  index: number;
  distanceToJoint: number;
  radius: number;
  radiusEnd?: number;
  name?: string;
  start?: number[];
  end?: number[];
}
interface CheckedBlends {
  status: string;
  blends: Array<{ kind: string; source?: string; lawChecked?: boolean; sourceEdges: string[]; radius?: { min: number; max: number } }>;
  findings: Array<{ code: string; severity: string }>;
}

/** Integral of f over [0, 1] by Simpson's rule on n (even) intervals. */
function integral(f: (u: number) => number, n = 2000): number {
  let sum = f(0) + f(1);
  for (let k = 1; k < n; k++) sum += f(k / n) * (k % 2 === 1 ? 4 : 2);
  return sum / (3 * n);
}

describeNative('BLD M5 (13.32): blend_union joints by name and per-joint radius laws (native OCCT kernel)', () => {
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
  const checked = (doc: Doc, id: string): CheckedBlends => execute(doc, 'check_blends', { ids: [id] }).data as CheckedBlends;
  const jointsOf = (result: ReturnType<typeof execute>): JointData[] => (result.data as { joints: JointData[] }).joints;
  const lawFindings = (data: CheckedBlends): CheckedBlends['findings'] =>
    data.findings.filter((finding) => finding.code === 'BLD_CHECK_RADIUS_LAW');

  /** A plate 40 x 20 x 4 with a stem 10 x 20 x 18 sunk 2 into it: two straight joints of length 20 on the plate top, at x = 15 and x = 25. */
  const tee = (s: number): { doc: Doc; ids: [string, string] } => {
    const plate = made(createEmptyDocument(), 'add_box', { size: [40 * s, 20 * s, 4 * s], position: [20 * s, 10 * s, 2 * s] });
    const stem = made(plate.doc, 'add_box', { size: [10 * s, 20 * s, 18 * s], position: [20 * s, 10 * s, 11 * s] });
    return { doc: stem.doc, ids: [plate.id, stem.id] };
  };
  const plainUnion = (s: number): number => (40 * 20 * 4 + 10 * 20 * 16) * s ** 3;
  /** Volume the joint at x = 15 and the default joint at x = 25 (radius 1 s) add, with `r` the radius of the picked joint along u in [0, 1]. */
  const expectedVolume = (s: number, r: (u: number) => number): number =>
    plainUnion(s) + CORNER * 20 * s * (s * s) * (integral((u) => r(u) * r(u)) + 1);

  describe('radius laws along a joint', () => {
    it.each(SIZES)('a linear law 0.5 -> 1.5 on the joint at x = 15 adds CORNER x L x (a^2 + ab + b^2) / 3 of material, %d mm', (s) => {
      const { doc, ids } = tee(s);
      const done = made(doc, 'blend_union', {
        ids,
        radius: 1 * s,
        joints: [{ near: [15 * s, 10 * s, 4 * s], radius: 0.5 * s, radiusEnd: 1.5 * s, interpolation: 'linear' }],
      });
      expect(done.result.error).toBeUndefined();
      const expected = expectedVolume(s, (u) => 0.5 + u);
      expect(Math.abs(volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-9);
      // the closed form itself: CORNER x 20 x (0.25 + 0.75 + 2.25) / 3 for the picked joint
      expect(integral((u) => (0.5 + u) ** 2)).toBeCloseTo((0.25 + 0.75 + 2.25) / 3, 12);
      const data = checked(done.doc, done.id);
      expect(data.status).toBe('pass');
      expect(lawFindings(data)).toEqual([]);
      const picked = data.blends.find((row) => row.source === 'joints[0]');
      expect(picked?.lawChecked).toBe(true);
      expect(picked?.radius?.min).toBeCloseTo(0.5 * s, 6);
      expect(picked?.radius?.max).toBeCloseTo(1.5 * s, 6);
      expect(data.blends.find((row) => row.source === 'default')?.radius).toMatchObject({
        min: expect.closeTo(s, 6),
        max: expect.closeTo(s, 6),
      });
    });

    it.each(SIZES)('a monotone law 0.5 -> 1.5 (one smoothstep) matches the numeric integral of r(u)^2, %d mm', (s) => {
      const { doc, ids } = tee(s);
      const done = made(doc, 'blend_union', {
        ids,
        radius: 1 * s,
        joints: [{ near: [15 * s, 10 * s, 4 * s], radius: 0.5 * s, radiusEnd: 1.5 * s, interpolation: 'monotone' }],
      });
      expect(done.result.error).toBeUndefined();
      const expected = expectedVolume(s, (u) => 0.5 + 3 * u * u - 2 * u ** 3);
      expect(Math.abs(volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-7);
      const data = checked(done.doc, done.id);
      expect(lawFindings(data)).toEqual([]);
      expect(data.blends.find((row) => row.source === 'joints[0]')?.lawChecked).toBe(true);
    });

    it('a law with a control point (linear pieces 1 -> 2 at the middle -> 0.5) is exact piece by piece', () => {
      const { doc, ids } = tee(1);
      const done = made(doc, 'blend_union', {
        ids,
        radius: 1,
        joints: [{ near: [15, 10, 4], radius: 1, radiusEnd: 0.5, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
      });
      expect(done.result.error).toBeUndefined();
      const r = (u: number): number => (u < 0.5 ? 1 + 2 * u : 2 - 3 * (u - 0.5));
      const expected = expectedVolume(1, r);
      expect(Math.abs(volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-7);
      expect(lawFindings(checked(done.doc, done.id))).toEqual([]);
    });

    it('an expression law is the sampled law: 0.6 + 0.8 u reads back within the check tolerance', () => {
      const { doc, ids } = tee(1);
      const done = made(doc, 'blend_union', {
        ids,
        radius: 1,
        joints: [{ near: [15, 10, 4], law: { expression: '0.6 + 0.8*t', samples: 9 }, interpolation: 'linear' }],
      });
      expect(done.result.error).toBeUndefined();
      const expected = expectedVolume(1, (u) => 0.6 + 0.8 * u);
      expect(Math.abs(volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-7);
      expect(lawFindings(checked(done.doc, done.id))).toEqual([]);
    });

    it('the law runs from the start of the joint edge (reported in data.joints): swapping radius and radiusEnd mirrors the blend, the volume is the same, both read back', () => {
      const { doc, ids } = tee(1);
      const forward = made(doc, 'blend_union', {
        ids,
        radius: 1,
        joints: [{ near: [15, 10, 4], radius: 0.5, radiusEnd: 1.5, interpolation: 'linear' }],
      });
      const backward = made(doc, 'blend_union', {
        ids,
        radius: 1,
        joints: [{ near: [15, 10, 4], radius: 1.5, radiusEnd: 0.5, interpolation: 'linear' }],
      });
      expect(volume(forward.doc, forward.id)).toBeCloseTo(volume(backward.doc, backward.id), 6);
      const [pick] = jointsOf(forward.result);
      expect(pick).toMatchObject({ index: 0, radius: 0.5, radiusEnd: 1.5, name: 'e(box-1.1:z+|box-2.1:x-)' });
      expect(Math.abs((pick?.start?.[1] ?? 0) - (pick?.end?.[1] ?? 0))).toBeCloseTo(20, 9);
      expect(JSON.stringify(forward.doc.featureHistory.at(-1)?.params)).not.toBe(
        JSON.stringify(backward.doc.featureHistory.at(-1)?.params),
      );
      for (const built of [forward, backward]) {
        const data = checked(built.doc, built.id);
        expect(lawFindings(data)).toEqual([]);
        expect(data.blends.find((row) => row.source === 'joints[0]')?.lawChecked).toBe(true);
      }
    });
  });

  describe('joints by persistent name', () => {
    const NAME_LEFT = 'e(box-1.1:z+|box-2.1:x-)';
    const NAME_RIGHT = 'e(box-1.1:z+|box-2.1:x+)';
    const params = (doc: Doc): Record<string, unknown> => doc.featureHistory.at(-1)?.params as Record<string, unknown>;
    /** edit_step_params on the box step that made `stemId`: its params with the new position (the edit replaces the params). */
    const moveStem = (doc: Doc, stemId: string, position: number[]): ReturnType<typeof execute> => {
      const step = doc.featureHistory.find((candidate) => candidate.name === 'add_box' && (candidate.affected ?? []).includes(stemId));
      expect(step).toBeDefined();
      return execute(doc, 'edit_step_params', { stepId: step?.id, params: { ...(step?.params as Record<string, unknown>), position } });
    };

    it('a pick by point records the name of its joint in the step; the same pick by name builds the same solid, and a name wins over a point on the other joint', () => {
      const { doc, ids } = tee(1);
      const byPoint = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 0.5 }] });
      expect(params(byPoint.doc)['joints']).toEqual([{ near: [15, 10, 4], radius: 0.5, name: NAME_LEFT }]);
      expect(jointsOf(byPoint.result)[0]).toMatchObject({ name: NAME_LEFT, distanceToJoint: 0 });
      const byName = made(doc, 'blend_union', { ids, radius: 1, joints: [{ name: NAME_LEFT, radius: 0.5 }] });
      expect(byName.result.error).toBeUndefined();
      expect(volume(byName.doc, byName.id)).toBe(volume(byPoint.doc, byPoint.id));
      expect(jointsOf(byName.result)[0]).toMatchObject({ name: NAME_LEFT, distanceToJoint: 0 });
      // the point sits on the right joint, the name says the left one: the name wins
      const both = made(doc, 'blend_union', { ids, radius: 1, joints: [{ name: NAME_LEFT, near: [25, 10, 4], radius: 0.5 }] });
      expect(volume(both.doc, both.id)).toBe(volume(byPoint.doc, byPoint.id));
      const rows = checked(both.doc, both.id).blends;
      expect(rows.find((row) => row.sourceEdges.includes(NAME_LEFT))?.source).toBe('joints[0]');
      expect(rows.find((row) => row.sourceEdges.includes(NAME_RIGHT))?.source).toBe('default');
    });

    it('regeneration follows the joint by name: after the stem moves, the radius stays on the joint it was given, not on the one nearest the old point', () => {
      const { doc, ids } = tee(1);
      const built = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 0.5 }] });
      // the stem now spans x = 7..17: the old point (15, 10, 4) is 2 from the right joint (x = 17) and 8 from the left one (x = 7)
      const edited = moveStem(built.doc, ids[1], [12, 10, 11]);
      expect(edited.rejected, edited.summary).toBeUndefined();
      const after = edited.document.order[0] as string;
      const rows = checked(edited.document, after).blends;
      expect(rows.find((row) => row.sourceEdges.includes(NAME_LEFT))?.source).toBe('joints[0]');
      expect(rows.find((row) => row.sourceEdges.includes(NAME_RIGHT))?.source).toBe('default');
      const expected = plainUnion(1) + CORNER * 20 * (0.25 + 1);
      expect(volume(edited.document, after)).toBeCloseTo(expected, 6);
      // replay reproduces the document
      const replayed = execute(edited.document, 'replay_history', {});
      expect(replayed.rejected, replayed.summary).toBeUndefined();
      expect(volume(replayed.document, replayed.document.order[0] as string)).toBeCloseTo(expected, 6);
    });

    it('a name that no joint has now is REF_LOST with the joints that exist, the document unchanged', () => {
      const { doc, ids } = tee(1);
      const lost = execute(doc, 'blend_union', { ids, radius: 1, joints: [{ name: 'e(box-1.1:z+|box-2.1:y-)', radius: 0.5 }] });
      expect(lost.document).toBe(doc);
      expect(lost.error).toMatchObject({ code: 'REF_LOST', paths: ['joints[0].name'] });
      expect(lost.summary).toContain(NAME_LEFT);
      expect(lost.summary).toContain(NAME_RIGHT);
      expect(lost.error?.remediation).toContain('edit_step_params');
    });

    it('a joint that disappears upstream is REF_LOST on regeneration, not a silent pick of another joint', () => {
      const { doc, ids } = tee(1);
      const built = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 0.5 }] });
      // the stem now spans x = -3..7: its left face is outside the plate, so the joint e(plate z+ | stem x-) is gone; the right joint (x = 7) remains
      const edited = moveStem(built.doc, ids[1], [2, 10, 11]);
      expect(edited.summary).toContain('REF_LOST');
      expect(edited.summary).toContain(NAME_LEFT);
    });

    it('a name that several joints have is REF_SPLIT (two cylinders through each other: the same two faces meet twice)', () => {
      const a = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 40 });
      const b = made(a.doc, 'add_cylinder', { radius: 3, height: 40, rotation: [Math.PI / 2, 0, 0] });
      const ids = [a.id, b.id];
      const base = 'e(cyl-1.1:side|cyl-2.1:side)';
      const split = execute(b.doc, 'blend_union', { ids, radius: 1, joints: [{ name: base, radius: 0.5 }] });
      expect(split.document).toBe(b.doc);
      expect(split.error).toMatchObject({ code: 'REF_SPLIT', paths: ['joints[0].name'] });
      expect(split.summary).toContain(base + '#1');
      expect(split.summary).toContain(base + '#2');
      // the full name of one of them is one joint
      const one = made(b.doc, 'blend_union', { ids, radius: 1, joints: [{ name: base + '#1', radius: 0.5 }] });
      expect(one.result.error).toBeUndefined();
      expect(jointsOf(one.result)[0]?.name).toBe(base + '#1');
      const rows = checked(one.doc, one.id).blends.filter((row) => row.kind === 'edge');
      expect(rows.map((row) => row.source).sort()).toEqual(['default', 'joints[0]']);
    });
  });

  describe('curved and chained joints', () => {
    /** A plate 40 x 40 x 5 (z -4..1) and a boss of radius 5 from z = 0 to 10: one circular joint of radius 5 on the plate top. */
    const boss = (): { doc: Doc; ids: [string, string] } => {
      const plate = made(createEmptyDocument(), 'add_box', { size: [40, 40, 5], position: [0, 0, -1.5] });
      const post = made(plate.doc, 'add_cylinder', { radius: 5, height: 10, position: [0, 0, 5] });
      return { doc: post.doc, ids: [plate.id, post.id] };
    };
    const plainBoss = 40 * 40 * 5 + Math.PI * 25 * 9;
    /** Pappus: the fillet section (a square r x r less a quarter disc) turned around the axis at the radius of its centroid. */
    const pappus = (wall: number, r: number): number => {
      const area = CORNER * r * r;
      const centroid = (r * (5 / 6 - Math.PI / 4)) / (1 - Math.PI / 4);
      return 2 * Math.PI * (wall + centroid) * area;
    };

    it('a constant radius on a circular joint, picked by name: the volume added is Pappus on the fillet section (closed form)', () => {
      const { doc, ids } = boss();
      const probe = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [5, 0, 1], radius: 0.7 }] });
      expect(probe.result.error).toBeUndefined();
      const name = jointsOf(probe.result)[0]?.name as string;
      const byName = made(doc, 'blend_union', { ids, radius: 1, joints: [{ name, radius: 0.7 }] });
      const expected = plainBoss + pappus(5, 0.7);
      expect(Math.abs(volume(byName.doc, byName.id) - expected) / expected).toBeLessThan(1e-9);
      expect(volume(byName.doc, byName.id)).toBe(volume(probe.doc, probe.id));
    });

    it('a closed joint takes a law only if it closes on itself: radius 0.5 -> 1 is BLD_LAW_NOT_PERIODIC, 0.5 -> 0.5 through 1 at the middle builds and reads back', () => {
      const { doc, ids } = boss();
      const open = execute(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [5, 0, 1], radius: 0.5, radiusEnd: 1 }] });
      expect(open.document).toBe(doc);
      expect(open.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', paths: ['joints[0].radiusEnd'] });
      expect(open.summary).toContain('closed curve');
      const closed = made(doc, 'blend_union', {
        ids,
        radius: 1,
        joints: [{ near: [5, 0, 1], radius: 0.5, radiusEnd: 0.5, sizes: [{ t: 0.5, size: 1 }], interpolation: 'monotone' }],
      });
      expect(closed.result.error, closed.result.summary).toBeUndefined();
      const data = checked(closed.doc, closed.id);
      expect(lawFindings(data)).toEqual([]);
      const row = data.blends.find((candidate) => candidate.source === 'joints[0]');
      expect(row?.radius?.min).toBeCloseTo(0.5, 6);
      expect(row?.radius?.max).toBeCloseTo(1, 4);
    });

    it('a radius that varies needs a joint alone in its tangent chain: the foot of a rounded post (4 lines + 4 arcs) takes a constant radius, not a law', () => {
      const plate = made(createEmptyDocument(), 'add_box', { size: [40, 40, 5], position: [0, 0, -1.5] });
      const post = made(plate.doc, 'add_box', { size: [10, 10, 10], position: [0, 0, 5] });
      const rounded = made(post.doc, 'fillet_edge', {
        id: post.id,
        radius: 2,
        edgesNear: [
          [5, 5, 5],
          [-5, 5, 5],
          [5, -5, 5],
          [-5, -5, 5],
        ],
      });
      expect(rounded.result.error, rounded.result.summary).toBeUndefined();
      const ids = [plate.id, rounded.id];
      const law = execute(rounded.doc, 'blend_union', { ids, radius: 1, joints: [{ near: [0, 5, 1], radius: 0.5, radiusEnd: 1 }] });
      expect(law.document).toBe(rounded.doc);
      expect(law.error).toMatchObject({ code: 'BLD_JOINT_PARAMS', paths: ['joints[0].radiusEnd'] });
      expect(law.summary).toMatch(/chained with \d+ other joint edge/);
      expect(law.error?.remediation).toContain('alone in its tangent chain');
      const constant = made(rounded.doc, 'blend_union', { ids, radius: 1, joints: [{ near: [0, 5, 1], radius: 0.5 }] });
      expect(constant.result.error, constant.result.summary).toBeUndefined();
      const rows = checked(constant.doc, constant.id).blends.filter((row) => row.kind === 'edge');
      expect(rows.filter((row) => row.source !== undefined).length).toBeGreaterThanOrEqual(8);
      expect(new Set(rows.flatMap((row) => (row.source === undefined ? [] : [row.source])))).toEqual(new Set(['joints[0]']));
    });

    it('two cylinders through each other at right angles: a constant joint radius adds the volume of the tube-coordinate integral (numeric quadrature, no kernel)', () => {
      // short cylinders (the joints reach 4.5 from the origin): the mass integral of the whole solid then has an error of about 3e-6 of it, far below the fillet
      const a = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 14 });
      const b = made(a.doc, 'add_cylinder', { radius: 3, height: 20, rotation: [Math.PI / 2, 0, 0] });
      const plain = volume(made(b.doc, 'boolean', { op: 'union', a: a.id, b: b.id }).doc, 'mesh-3.1');
      for (const radius of [0.75, 1]) {
        const blended = made(b.doc, 'blend_union', { ids: [a.id, b.id], radius });
        expect(blended.result.error, blended.result.summary).toBeUndefined();
        const added = volume(blended.doc, blended.id) - plain;
        const expected = crossedCylindersFilletVolume(5, 3, radius);
        expect(Math.abs(added - expected) / expected, `radius ${radius}: ${added} vs ${expected}`).toBeLessThan(5e-3);
      }
    });
  });
});
