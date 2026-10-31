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
import { blendFaceContacts } from '@core/geometry/blend/blendInfo';
import { checkRadius, lawIndex } from '@core/commands/brep/checkBlendRadius';

type Doc = CadDocument;
type LawRecord = ReturnType<typeof lawIndex> extends Map<string, infer R> ? R : never;
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
  blends: Array<{
    face: number;
    kind: string;
    source?: string;
    lawChecked?: boolean;
    sourceEdges: string[];
    radius?: { min: number; max: number };
  }>;
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

    it('a #k name records the midpoint of its joint, and a regeneration refuses (REF_LOST) the joint that took the number over when the two swapped order', () => {
      const a = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 14 });
      const b = made(a.doc, 'add_cylinder', { radius: 3, height: 20, rotation: [Math.PI / 2, -0.5, 0] });
      const ids = [a.id, b.id];
      // #k numbers the joints of the same two faces by the position of their midpoints: tilted this way the loop at y > 0 is #2 (its middle at about (-0.72, 4.95, 0))
      const built = made(b.doc, 'blend_union', { ids, radius: 0.2, joints: [{ near: [-3, 4, 0], radius: 0.3 }] });
      expect(built.result.error, built.result.summary).toBeUndefined();
      const recorded = (params(built.doc)['joints'] as Array<{ name: string; nameMid: number[] }>)[0] as {
        name: string;
        nameMid: number[];
      };
      expect(recorded.name).toBe('e(cyl-1.1:side|cyl-2.1:side)#2');
      expect(recorded.nameMid[1]).toBeGreaterThan(4.5);
      const step = built.doc.featureHistory.find(
        (candidate) => candidate.name === 'add_cylinder' && (candidate.affected ?? []).includes(b.id),
      );
      const tilt = (doc: Doc, angle: number): ReturnType<typeof execute> =>
        execute(doc, 'edit_step_params', {
          stepId: step?.id,
          params: { ...(step?.params as Record<string, unknown>), rotation: [Math.PI / 2, angle, 0] },
        });
      // a small edit keeps the joint where it was: still the same loop
      const nudged = tilt(built.doc, -0.45);
      expect(nudged.rejected, nudged.summary).toBeUndefined();
      expect(nudged.summary).not.toContain('REF_LOST');
      // tilted the other way the loop at y > 0 is #1 and #2 is the loop at y < 0, about 10 away: the number is not followed to another joint
      const swapped = tilt(built.doc, 0.5);
      expect(swapped.summary).toContain('REF_LOST');
      expect(swapped.summary).toContain('numbering');
      // the same step without the recorded midpoint silently gives the radius to the other loop: what the midpoint prevents
      const blendStep = built.doc.featureHistory.at(-1);
      const bare = execute(built.doc, 'edit_step_params', {
        stepId: blendStep?.id,
        params: { ...(blendStep?.params as Record<string, unknown>), joints: [{ near: [-3, 4, 0], radius: 0.3, name: recorded.name }] },
      });
      expect(bare.rejected, bare.summary).toBeUndefined();
      const silent = tilt(bare.document, 0.5);
      expect(silent.rejected, silent.summary).toBeUndefined();
      expect(silent.summary).not.toContain('REF_LOST');
    });

    it('editing near on a step that recorded the name of its joint changes nothing, and the result says so', () => {
      const { doc, ids } = tee(1);
      const built = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 0.5 }] });
      expect(built.result.summary).not.toContain('near ignored');
      const step = built.doc.featureHistory.at(-1);
      const edited = execute(built.doc, 'edit_step_params', {
        stepId: step?.id,
        params: { ...(step?.params as Record<string, unknown>), joints: [{ near: [25, 10, 4], radius: 0.5, name: NAME_LEFT }] },
      });
      expect(edited.rejected, edited.summary).toBeUndefined();
      expect(volume(edited.document, edited.document.order[0] as string)).toBe(volume(built.doc, built.id));
      // edit_step_params does not carry the regenerated step's own summary: the same params run directly say it
      const direct = execute(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [25, 10, 4], radius: 0.5, name: NAME_LEFT }] });
      expect(direct.summary).toContain(`joints[0] picked by name ${NAME_LEFT}; near ignored`);
      expect(jointsOf(direct)[0]).toMatchObject({ name: NAME_LEFT, nearIgnored: true });
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

    it('a closed joint refuses interior sizes that do not mirror about t = 1/2 (its direction cannot be told), and takes ones that do', () => {
      const { doc, ids } = boss();
      const law = (sizes: Array<{ t: number; size: number }>): Record<string, unknown> => ({
        ids,
        radius: 1,
        joints: [{ near: [5, 0, 1], radius: 0.5, radiusEnd: 0.5, sizes }],
      });
      const asymmetric = execute(doc, 'blend_union', law([{ t: 0.25, size: 0.8 }]));
      expect(asymmetric.document).toBe(doc);
      expect(asymmetric.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', paths: ['joints[0].sizes'] });
      expect(asymmetric.summary).toContain('mirror about t = 1/2');
      const uneven = execute(
        doc,
        'blend_union',
        law([
          { t: 0.25, size: 0.8 },
          { t: 0.75, size: 0.9 },
        ]),
      );
      expect(uneven.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC' });
      const mirrored = made(
        doc,
        'blend_union',
        law([
          { t: 0.25, size: 0.8 },
          { t: 0.75, size: 0.8 },
        ]),
      );
      expect(mirrored.result.error, mirrored.result.summary).toBeUndefined();
    });

    /**
     * Joint laws on uneven-speed edges (13.32.5): the kernel lays the law on the arc length of the joint (law_fillet.cxx), and check_blends reads it back at the
     * spine position of each section (the kernel's `unevenSpeed` flag on the contour note). The law has its nodes at 0.15 and 0.85, where the parameter fraction
     * and the arc fraction of these joints differ (a 2:1 ellipse; two cylinders through each other off the axes), so a readback at the parameter fraction would flag it.
     */
    describe('laws on uneven-speed joints', () => {
      const law = (peak: number): Record<string, unknown> => ({
        radius: 0.2,
        radiusEnd: 0.2,
        interpolation: 'linear',
        sizes: [
          { t: 0.15, size: peak },
          { t: 0.85, size: peak },
        ],
      });
      const row = (data: CheckedBlends): CheckedBlends['blends'][number] | undefined =>
        data.blends.find((candidate) => candidate.source === 'joints[0]');
      const tiltedPost = (): { doc: Doc; ids: string[]; near: number[] } => {
        const plate = made(createEmptyDocument(), 'add_box', { size: [80, 80, 40], position: [0, 0, -20] });
        const tilt = Math.PI / 3;
        const post = made(plate.doc, 'add_cylinder', { radius: 3, height: 20, rotation: [0, tilt, 0] });
        return { doc: post.doc, ids: [plate.id, post.id], near: [3 / Math.cos(tilt), 0, 0] };
      };
      const crossed = (): { doc: Doc; ids: string[]; near: number[] } => {
        const a = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 14 });
        const b = made(a.doc, 'add_cylinder', { radius: 2.5, height: 20, rotation: [Math.PI / 2, 0, 0], position: [2, 0, 2] });
        return { doc: b.doc, ids: [a.id, b.id], near: [4.5, Math.sqrt(25 - 4.5 * 4.5), 2] };
      };

      it.each([
        ['a post tilted 60 degrees on a plate (ellipse 6 x 3)', tiltedPost],
        ['two cylinders through each other off the axes', crossed],
      ])(
        '%s: the law is read back at the spine position of each section (the kernel flags the joint uneven), within 1e-2, where the parameter fraction is off by 2e-2 or more',
        (_label, scene) => {
          const { doc, ids, near } = scene();
          const built = made(doc, 'blend_union', { ids, radius: 0.2, joints: [{ near, ...law(0.6) }] });
          expect(built.result.error, built.result.summary).toBeUndefined();
          const brep = (built.doc.entities[built.id] as unknown as { brep: Parameters<typeof kernel.evaluate>[0] }).brep;
          const shape = kernel.evaluate(brep) as NonNullable<ReturnType<typeof kernel.evaluate>>;
          const face = row(checked(built.doc, built.id))?.face;
          const blend = blendFaceContacts(
            kernel.topology(shape) as NonNullable<ReturnType<typeof kernel.topology>>,
            kernel.faceQuery?.faceGraph(shape) as NonNullable<ReturnType<NonNullable<typeof kernel.faceQuery>['faceGraph']>>,
          ).find((candidate) => candidate.face === face) as NonNullable<ReturnType<typeof blendFaceContacts>[number]>;
          const record = [...lawIndex(kernel, brep).values()].find(
            (candidate) => candidate.source === 'joints[0]',
          ) as NonNullable<LawRecord>;
          expect(record.joint?.unevenSpeed).toBe(true);
          expect(record.joint?.spine).toHaveLength(401);
          const worst = (checkedRecord: LawRecord): number =>
            Math.max(0, ...checkRadius(kernel, shape, blend, checkedRecord, 21).deviations.map((deviation) => deviation.deviation));
          const along = checkRadius(kernel, shape, blend, record, 21);
          expect(along.lawChecked).toBe(true);
          expect(worst(record)).toBeLessThan(1e-2);
          // the same record without the kernel's flag is read at the parameter fraction of the sections: off by a lot more
          const legacy = {
            ...record,
            joint: { isolated: true, ...(record.joint?.samples === undefined ? {} : { samples: record.joint.samples }) },
          };
          expect(worst(legacy)).toBeGreaterThan(2e-2);
        },
      );
    });

    it('a default-radius union and a three-solid corner union keep the face names and the volume of the build before the law-capable fillet (pins measured with the parent kernel)', () => {
      const names = (doc: Doc, id: string): string[] =>
        (execute(doc, 'inspect_topology', { id }).data as { faces: Array<{ name?: string }> }).faces.map((face) => face.name ?? '').sort();
      // pinned from the llull-kernel built before the LawFillet switch (BRepFilletAPI_MakeFillet), same inputs
      for (const [scale, pinned] of [
        [1, 6402.146018366026],
        [10, 6402146.018366025],
      ] as const) {
        const { doc, ids } = tee(scale);
        const joined = made(doc, 'blend_union', { ids, radius: 0.5 * scale });
        expect(joined.result.error, joined.result.summary).toBeUndefined();
        expect(Math.abs(volume(joined.doc, joined.id) - pinned) / pinned).toBeLessThan(1e-12);
        const all = names(joined.doc, joined.id);
        expect(all).toHaveLength(16);
        expect(all.filter((name) => name.startsWith('blend('))).toEqual([
          'blend(e(box-1.1:z+|box-2.1:x+))',
          'blend(e(box-1.1:z+|box-2.1:x-))',
        ]);
      }
      const floor = made(createEmptyDocument(), 'add_box', { size: [30, 30, 4], position: [15, 15, -2] });
      const wallX = made(floor.doc, 'add_box', { size: [2, 30, 11], position: [1, 15, 4.5] });
      const wallY = made(wallX.doc, 'add_box', { size: [30, 2, 11], position: [15, 1, 4.5] });
      const corner = made(wallY.doc, 'blend_union', { ids: [floor.id, wallX.id, wallY.id], radius: 0.5 });
      expect(corner.result.error, corner.result.summary).toBeUndefined();
      expect(Math.abs(volume(corner.doc, corner.id) - 4763.5200047682665) / 4763.52).toBeLessThan(1e-12);
      const cornerNames = names(corner.doc, corner.id);
      expect(cornerNames).toHaveLength(27);
      expect(cornerNames.filter((name) => name.startsWith('blend('))).toEqual([
        'blend(e(box-1.1:z+|box-2.1:x+))',
        'blend(e(box-1.1:z+|box-3.1:y+))',
        'blend(e(box-2.1:x+|box-3.1:y+))',
        'blend(v:e(box-1.1:z+|box-2.1:x+),e(box-1.1:z+|box-3.1:y+),e(box-2.1:x+|box-3.1:y+))',
      ]);
    });
  });
});
