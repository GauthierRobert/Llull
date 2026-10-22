/** SWG M3: lib/helix, add_helix, sweeps along helices and 3D curves, axis_plane screw sweeps (validation VC-SWG-04, 08, 12..14, 25, 27, 34). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type NurbsCurveEntity, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { helixAt, helixCurve, helixDifferentials, helixHeightAt, helixLength } from '@lib/helix/helix';
import type { HelixDefinition } from '@lib/helix/types';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { volumeOf } from '../../helpers/fixtureDocument';
import { relError, runSwgPlan, swgPlan, swgValue } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();
const MESH = 0.005;
const cylinder: HelixDefinition = {
  type: 'helix',
  origin: [0, 0, 0],
  axis: [0, 0, 1],
  radius: 20,
  endRadius: 20,
  turns: 3,
  pitch: 10,
  handedness: 'right',
  startAngle: 0,
};

function helix(params: Record<string, unknown>, doc: CadDocument = empty): { doc: CadDocument; id: string; data: Record<string, number> } {
  const result = execute(doc, 'add_helix', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string, data: result.data as Record<string, number> };
}

function refused(params: Record<string, unknown>, code: string): void {
  const result = execute(empty, 'add_helix', params);
  expectNoOp(result, empty, code);
  expect(result.error?.code).toBe(code);
}

describe('lib/helix', () => {
  it('cylindrical helix: length, curvature radius and torsion match the closed forms (VC-SWG-12)', () => {
    const lead = 10 / (2 * Math.PI);
    expect(relError(helixLength(cylinder), 3 * 2 * Math.PI * Math.hypot(20, lead))).toBeLessThan(1e-12);
    expect(helixLength(cylinder)).toBeCloseTo(378.1829, 4);
    const { curvatureRadiusMin, torsionMean } = helixDifferentials(cylinder);
    expect(curvatureRadiusMin).toBeCloseTo(20.12665, 5);
    expect(torsionMean).toBeCloseTo(0.0039538, 7);
    expect(helixDifferentials({ ...cylinder, handedness: 'left' }).torsionMean).toBeCloseTo(-0.0039538, 7);
  });
  it('conical helix length (VC-SWG-14) and the numeric differentials of a variable helix', () => {
    const cone: HelixDefinition = { ...cylinder, endRadius: 10, turns: 5 };
    expect(relError(helixLength(cone), swgValue('VC-SWG-14', 'conical_helix_tube') / (Math.PI * 1))).toBeLessThan(1e-9);
    const d = helixDifferentials(cone);
    expect(d.curvatureRadiusMin).toBeGreaterThan(8);
    expect(d.torsionMean).toBeGreaterThan(0);
  });
  it('a pitch law integrates to the height; a spiral stays in its plane', () => {
    const law: HelixDefinition = { ...cylinder, pitch: { type: 'linear', start: 2, end: 6 }, turns: 4 };
    expect(helixHeightAt(law, 1)).toBeCloseTo(16, 9);
    expect(helixHeightAt(law, 0.5)).toBeCloseTo(4 * (2 * 0.5 + 2 * 0.25), 9);
    const spiral: HelixDefinition = { ...cylinder, type: 'spiral', endRadius: 40, pitch: 0 };
    expect(helixAt(spiral, 3).point[2]).toBe(0);
    expect(helixHeightAt(spiral, 1)).toBe(0);
  });
  it('the NURBS chain stays within the tolerance of the exact helix (VC-SWG-08: today 0.2323, target 2e-5)', () => {
    const { curve, deviation } = helixCurve(cylinder, 2e-5);
    expect(deviation).toBeLessThan(2e-5);
    for (const u of [0.013, 0.2, 0.5, 0.77, 0.99]) {
      const point = evaluateCurve(curve, u);
      expect(Math.abs(Math.hypot(point[0], point[1]) - 20)).toBeLessThan(2e-5);
    }
  });
});

describe('add_helix', () => {
  it('VC-SWG-12/08: builds a nurbs_curve with its definition, length, curvature, torsion and fit deviation', () => {
    const { doc, id, data } = helix({ radius: 20, pitch: 10, turns: 3 });
    const curve = doc.entities[id] as NurbsCurveEntity;
    expect(curve.kind).toBe('nurbs_curve');
    expect(curve.analytic).toMatchObject({ type: 'helix', radius: 20, turns: 3, pitch: 10, handedness: 'right' });
    expect(data['length']).toBeCloseTo(378.1829, 4);
    expect(data['curvatureRadiusMin']).toBeCloseTo(20.12665, 5);
    expect(data['torsion']).toBeCloseTo(0.0039538, 7);
    expect(data['height']).toBeCloseTo(30, 12);
    expect(data['pitch']).toBeCloseTo(10, 12);
    expect(data['fitDeviation']).toBeLessThan(2e-5);
    expect(doc.order).toEqual([id]);
  });
  it('accepts height with turns or with pitch, a left hand, a position and a start angle', () => {
    expect(helix({ radius: 5, height: 24, turns: 4 }).data['pitch']).toBeCloseTo(6, 12);
    expect(helix({ radius: 5, height: 24, pitch: 6 }).data['height']).toBeCloseTo(24, 12);
    const left = helix({ radius: 5, pitch: 2, turns: 1, handedness: 'left', startAngleRad: Math.PI / 2, position: [3, 4, 5] });
    const curve = left.doc.entities[left.id] as NurbsCurveEntity;
    expect(curve.position).toEqual([3, 4, 5]);
    expect(curve.curve.poles[0]?.[0]).toBeCloseTo(0, 12);
    expect(curve.curve.poles[0]?.[1]).toBeCloseTo(5, 12);
    expect(left.data['torsion']).toBeLessThan(0);
  });
  it('conical by endRadius or taperDeg; a spiral by endRadius or by pitch; a pitch law with turns', () => {
    expect(relError(helix({ radius: 20, endRadius: 10, pitch: 10, turns: 5 }).data['length'] as number, 474.097)).toBeLessThan(1e-6);
    const tapered = helix({ radius: 20, taperDeg: Math.atan(10 / 50) * (180 / Math.PI), pitch: 10, turns: 5 });
    expect(tapered.data['length']).toBeCloseTo(474.097, 2);
    const byEnd = helix({ type: 'spiral', radius: 5, endRadius: 15, turns: 2 });
    const byPitch = helix({ type: 'spiral', radius: 5, pitch: 5, turns: 2 });
    expect(byEnd.data['length']).toBeCloseTo(byPitch.data['length'] as number, 9);
    expect(byEnd.data['height']).toBe(0);
    const law = helix({
      radius: 15,
      turns: 8,
      pitchLaw: {
        type: 'table',
        points: [
          [0, 2],
          [0.125, 2],
          [0.2, 6],
          [0.8, 6],
          [0.875, 2],
          [1, 2],
        ],
      },
    });
    expect(law.data['height']).toBeGreaterThan(30);
    expect(law.data['fitDeviation']).toBeLessThan(15e-6);
  });
  it('SWG_HELIX_PARAMS: not exactly two of pitch / turns / height, a bad axis, a mixed spiral or law call', () => {
    refused({ radius: 5, pitch: 2 }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, pitch: 2, turns: 3, height: 6 }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, pitch: 2, turns: 0 }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, pitch: 2, turns: 500 }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, pitch: 2, turns: 3, axis: [0, 0, 0] }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, pitch: 2, turns: 3, endRadius: 4, taperDeg: 5 }, 'SWG_HELIX_PARAMS');
    refused({ type: 'spiral', radius: 5, turns: 2 }, 'SWG_HELIX_PARAMS');
    refused({ type: 'spiral', radius: 5, turns: 2, endRadius: 9, pitch: 2 }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, turns: 3, pitchLaw: { type: 'constant', value: 2 }, pitch: 2 }, 'SWG_HELIX_PARAMS');
    refused({ radius: 5, pitchLaw: { type: 'constant', value: 2 } }, 'SWG_HELIX_PARAMS');
  });
  it('SWG_HELIX_RADIUS / SWG_LAW_* / SWG_FIT_TOLERANCE', () => {
    refused({ radius: 0, pitch: 2, turns: 3 }, 'SWG_HELIX_RADIUS');
    refused({ radius: 5, pitch: 2, turns: 3, taperDeg: 60 }, 'SWG_HELIX_RADIUS');
    refused({ radius: 5, turns: 3, pitchLaw: { type: 'linear', start: 2, end: -1 } }, 'SWG_LAW_NONPOSITIVE');
    refused(
      {
        radius: 5,
        turns: 3,
        pitchLaw: {
          type: 'table',
          points: [
            [0, 1],
            [0.6, 2],
            [0.5, 3],
            [1, 1],
          ],
        },
      },
      'SWG_LAW_INVALID',
    );
    refused({ radius: 5, turns: 3, pitchLaw: { type: 'linear', start: 2 } }, 'SWG_LAW_INVALID');
    refused({ radius: 20, pitch: 10, turns: 3, tolerance: 1e-18 }, 'SWG_FIT_TOLERANCE');
    refused({ radius: 20, pitch: 10, turns: 3, tolerance: -1 }, 'SWG_FIT_TOLERANCE');
  });
  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'add_helix', { radius: 20, pitch: 10, turns: 3 }));
  });
});

describe('sweeps along helices (target_helix_spring_thread)', () => {
  const plan = runSwgPlan(swgPlan('target_helix_spring_thread'));
  it('every step of the pack plan succeeds', () => {
    expect(plan.steps.filter((s) => !s.ok).map((s) => s.summary)).toEqual([]);
  });
  it('VC-SWG-12: a round tube has the exact-helix length volume (pi r^2 L)', () => {
    expect(relError(plan.volumeOf('tube'), swgValue('VC-SWG-12', 'round_tube_on_helix'))).toBeLessThan(1e-9);
  });
  it('VC-SWG-14: a round wire on a conical helix', () => {
    expect(relError(plan.volumeOf('conicalTube'), swgValue('VC-SWG-14', 'conical_helix_tube'))).toBeLessThan(1e-9);
  });
  it('VC-SWG-13: a screw section has w h 2 pi r n whatever the pitch (mesh)', () => {
    const reference = swgValue('VC-SWG-13', 'screw_rectangle_pitch10');
    expect(relError(plan.volumeOf('screw10'), reference)).toBeLessThan(MESH);
    expect(relError(plan.volumeOf('screw5'), swgValue('VC-SWG-13', 'screw_rectangle_pitch5'))).toBeLessThan(MESH);
  });
  it('add_coil v2 on the exact helix has the tube volume of the same helix', () => {
    expect(relError(plan.volumeOf('coil'), swgValue('VC-SWG-12', 'round_tube_on_helix'))).toBeLessThan(1e-9);
  });
  it('the sweeps remember their helix, and the screw frame is an axis_plane sweep', () => {
    const screw = Object.values(plan.document.entities).find(
      (e): e is SweepEntity => e.kind === 'sweep' && e.orientation?.mode === 'axis_plane',
    );
    expect(screw?.helix).toMatchObject({ radius: 20, turns: 3 });
    expect(screw?.orientation).toMatchObject({ mode: 'axis_plane', sectionFrame: 'axial', direction: [0, 0, 1] });
  });
});

describe('sweeps — frames and 3D paths', () => {
  it('VC-SWG-04: a square twisted 720 deg along the helix keeps A L', () => {
    const { doc, id } = helix({ radius: 20, pitch: 10, turns: 3 });
    const result = execute(doc, 'sweep_profile', {
      pathId: id,
      section: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      twist: { type: 'linear', start: 0, end: 4 * Math.PI },
    });
    expect(result.affected, result.summary).toHaveLength(1);
    expect(
      relError(
        volumeOf(result.document.entities[result.affected[0] as string] as SweepEntity),
        swgValue('VC-SWG-04', 'helix_linear_0_to_720deg'),
      ),
    ).toBeLessThan(MESH);
  });
  it('VC-SWG-25: the Frenet frame turns 2 pi c / sqrt(R^2 + c^2) per turn relative to the twist-free frame', () => {
    const { doc, id } = helix({ radius: 20, pitch: 10, turns: 1 });
    const swept = execute(doc, 'sweep_profile', { pathId: id, radius: 2 });
    const data = execute(swept.document, 'inspect_sweep', { id: swept.affected[0] as string }).data as {
      totals: { twistVsFrenetRad: number };
    };
    const c = 10 / (2 * Math.PI);
    expect(data.totals.twistVsFrenetRad).toBeCloseTo((2 * Math.PI * c) / Math.hypot(20, c), 6);
    expect((2 * Math.PI * c) / Math.hypot(20, c)).toBeCloseTo(0.4984243, 6);
  });
  it('a sweep along an interpolated 3D curve follows it (A L)', () => {
    const curve = execute(empty, 'interpolate_curve', { points: xyz(0, 0, 0, 10, 4, 6, 20, 0, 12, 30, -4, 18, 40, 0, 24) });
    expect(curve.affected, curve.summary).toHaveLength(1);
    const swept = execute(curve.document, 'sweep_profile', {
      pathId: curve.affected[0],
      section: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
    });
    expect(swept.affected, swept.summary).toHaveLength(1);
    const entity = swept.document.entities[swept.affected[0] as string] as SweepEntity;
    const length = (execute(swept.document, 'inspect_sweep', { id: entity.id }).data as { pathLength: number }).pathLength;
    expect(relError(volumeOf(entity), 4 * length)).toBeLessThan(0.01);
  });
  it('a rational or high-degree curve is refused as a path with SWG_PATH_INVALID', () => {
    const conic = execute(empty, 'create_nurbs_curve', {
      degree: 2,
      poles: [
        [0, 0, 0],
        [5, 5, 0],
        [10, 0, 0],
      ],
      weights: [1, 0.7, 1],
    });
    expectNoOp(execute(conic.document, 'sweep_profile', { pathId: conic.affected[0], radius: 0.2 }), conic.document, 'SWG_PATH_INVALID');
    const quartic = execute(empty, 'create_nurbs_curve', { degree: 4, poles: xyz(0, 0, 0, 2, 3, 0, 4, 0, 0, 6, 3, 0, 8, 0, 0) });
    expectNoOp(
      execute(quartic.document, 'sweep_profile', { pathId: quartic.affected[0], radius: 0.1 }),
      quartic.document,
      'SWG_PATH_INVALID',
    );
  });
  it('axis_plane needs its axis (or a helix), and refuses a path on the axis or in the axis plane', () => {
    const section = [
      [8, -1],
      [12, -1],
      [12, 1],
      [8, 1],
    ];
    const bar = xyz(0, 0, 0, 0, 0, 20);
    const ask = (path: number[][], orientation: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(empty, 'sweep_profile', { path, section, sectionFrame: 'axial', orientation });
    expectNoOp(ask(bar, { mode: 'axis_plane' }), empty, 'SWG_FRAME_DEGENERATE');
    expectNoOp(ask(bar, { mode: 'axis_plane', direction: [0, 0, 1], axisPoint: [0, 0, 0] }), empty, 'SWG_FRAME_DEGENERATE');
    expectNoOp(
      ask(xyz(10, 0, 0, 10, 0, 20), { mode: 'axis_plane', direction: [0, 0, 1], axisPoint: [0, 0, 0] }),
      empty,
      'SWG_FRAME_DEGENERATE',
    );
  });
  it('a wide tube on a tight helix overlaps its turns: SWG_SELF_INTERSECTION_GLOBAL', () => {
    const { doc, id } = helix({ radius: 20, pitch: 3, turns: 3 });
    expectNoOp(execute(doc, 'sweep_profile', { pathId: id, radius: 2 }), doc, 'SWG_SELF_INTERSECTION_GLOBAL');
  });
});

describe('VC-SWG-27 — the refusal plan', () => {
  it('each step of bad_refusals.json is refused with the stated code', () => {
    const plan = swgPlan('bad_refusals');
    const outcome = execute(empty, 'build_project', { actions: plan, onError: 'continue' });
    const steps = (outcome.data as { steps: { index: number; ok: boolean; summary: string }[] }).steps;
    const expected: Record<number, string> = {
      2: 'SWG_SELF_INTERSECTION_LOCAL',
      4: 'SWG_CLOSED_TWIST_NOT_PERIODIC',
      5: 'SWG_FRAME_DEGENERATE',
      7: 'SWG_SELF_INTERSECTION_GLOBAL',
      8: 'SWG_LAW_NONPOSITIVE',
      9: 'SWG_LAW_INVALID',
    };
    for (const [index, code] of Object.entries(expected)) {
      const step = steps.find((s) => s.index === Number(index));
      expect(step?.ok, `step ${index}`).toBe(false);
      expect(step?.summary, `step ${index}`).toContain(code);
    }
  });
});
