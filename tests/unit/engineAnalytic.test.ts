/**
 * Cylinder pressure models, engine geometry and the analytic engine_quick_check, without a physics engine: exact slider-crank formulas
 * (VC-FPR-10..12), Wiebe calibration linearity (VC-FPR-15 ingredients), table coverage, TDC from geometry, command validation.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { CylinderPressure } from '@core/model/dynamics';
import { engineLayout } from '@core/dynamics/engineGeometry';
import { modelProblem, pressureCurve } from '@core/dynamics/cylinderPressure';
import { gaugeAt } from '@core/dynamics/pressureCurve';
import { buildTopology } from '@core/dynamics/topology';
import { createSlider, sliderRate, sliderStroke, sliderTravel } from '@core/dynamics/slider';
import { sliderCrank, travel, travelRate } from './sliderCrankFixture';

const R = 0.0492125;
const L = 0.15;
const DEG = Math.PI / 180;
const ANGLES = [30, 60, 90, 120, 150];

interface QuickData {
  geometry: { strokeMm: number };
  angles: {
    angleDeg: number;
    travelMm: number;
    torqueNm?: number;
    rodForceN?: number;
    sideThrustN?: number;
    forceN?: number;
    gaugeBar?: number;
  }[];
  mean?: { meanTorqueNm: number; powerKW?: number; mepBar: number };
  cylinder?: { imepBar: number };
}

const quick = (doc: CadDocument, params: Record<string, unknown>): QuickData => {
  const result = execute(doc, 'engine_quick_check', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as QuickData;
};

describe('exact slider-crank formulas (VC-FPR-10, 11, 12)', () => {
  const data = quick(sliderCrank().doc, { crankRadiusMm: 49.2125, rodLengthMm: 150, forceN: 1000, anglesDeg: ANGLES });

  it('piston travel at 30..150 deg matches the reference values to 1e-4 mm', () => {
    const expected = [8.6252, 30.7883, 57.5152, 80.0008, 93.8638];
    data.angles.forEach((a, i) => expect(Math.abs(a.travelMm - (expected[i] ?? 0))).toBeLessThan(1e-4));
    data.angles.forEach((a, i) => expect(a.travelMm / 1000).toBeCloseTo(travel(R, L, (ANGLES[i] ?? 0) * DEG), 12));
  });

  it('crank torque F dx/dtheta, rod force F/cos(beta), side thrust F tan(beta) match the reference values', () => {
    const torque = [31.6936, 49.9111, 49.2125, 35.3274, 17.5189];
    const rod = [1013.733, 1042.985, 1058.594, 1042.985, 1013.733];
    const side = [166.294, 296.342, 347.307, 296.342, 166.294];
    data.angles.forEach((a, i) => {
      expect(Math.abs((a.torqueNm ?? 0) - (torque[i] ?? 0)) / (torque[i] ?? 1)).toBeLessThan(5e-6);
      expect(Math.abs((a.rodForceN ?? 0) - (rod[i] ?? 0)) / (rod[i] ?? 1)).toBeLessThan(1e-5);
      expect(Math.abs((a.sideThrustN ?? 0) - (side[i] ?? 0)) / (side[i] ?? 1)).toBeLessThan(1e-5);
    });
  });

  it('the two torque forms agree (F dx/dtheta = F r sin(theta + beta) / cos(beta)) and dx/dtheta is the derivative of x', () => {
    const slider = createSlider(R, L);
    for (const deg of ANGLES) {
      const theta = deg * DEG;
      const beta = Math.asin((R / L) * Math.sin(theta));
      expect(sliderRate(slider, theta)).toBeCloseTo((R * Math.sin(theta + beta)) / Math.cos(beta), 12);
      const h = 1e-6;
      expect((sliderTravel(slider, theta + h) - sliderTravel(slider, theta - h)) / (2 * h)).toBeCloseTo(travelRate(R, L, theta), 8);
    }
    expect(sliderStroke(slider)).toBeCloseTo(2 * R, 12);
  });

  it('an offset cylinder: top angle off zero, travel 0 at the top, rate 0 there, derivative consistent', () => {
    const slider = createSlider(R, L, 0.02);
    expect(slider.top).not.toBe(0);
    expect(sliderTravel(slider, 0)).toBe(0);
    expect(Math.abs(sliderRate(slider, 0))).toBeLessThan(1e-7);
    const h = 1e-6;
    expect((sliderTravel(slider, 0.7 + h) - sliderTravel(slider, 0.7 - h)) / (2 * h)).toBeCloseTo(sliderRate(slider, 0.7), 8);
    expect(sliderStroke(slider)).toBeGreaterThan(2 * R - 1e-9);
  });
});

describe('mean torque, MEP and power (VC-FPR-15 relation)', () => {
  it('73.5 kW at 5800 rpm from a 1352 cm3 four-stroke is 11.2477 bar and 121.013 N·m', () => {
    const mep = (73.5e3 * 2 * 60) / (1352e-6 * 5800) / 1e5;
    expect(mep).toBeCloseTo(11.2477, 4);
    const data = quick(sliderCrank().doc, {
      crankRadiusMm: 30.5,
      rodLengthMm: 130,
      mepBar: mep,
      displacementCm3: 1352,
      rpm: 5800,
      anglesDeg: [0],
    });
    expect(data.mean?.meanTorqueNm).toBeCloseTo(121.013, 2);
    expect(data.mean?.powerKW).toBeCloseTo(73.5, 6);
  });

  it('a two-stroke gives twice the torque for the same MEP and displacement', () => {
    const four = quick(sliderCrank().doc, { crankRadiusMm: 30, rodLengthMm: 100, mepBar: 8, displacementCm3: 500 });
    const two = quick(sliderCrank().doc, { crankRadiusMm: 30, rodLengthMm: 100, mepBar: 8, displacementCm3: 500, cycle: 'two_stroke' });
    expect((two.mean?.meanTorqueNm ?? 0) / (four.mean?.meanTorqueNm ?? 1)).toBeCloseTo(2, 12);
  });

  it('refuses without geometry, with an impossible rod, an unknown cylinder, or an MEP without displacement', () => {
    const { doc } = sliderCrank();
    const run = (params: Record<string, unknown>): string => execute(doc, 'engine_quick_check', params).summary;
    expect(run({})).toMatch(/crankRadiusMm and rodLengthMm/);
    expect(run({ crankRadiusMm: 60, rodLengthMm: 50 })).toMatch(/longer than/);
    expect(run({ cylinder: 'ghost' })).toMatch(/not found/);
    expect(run({ crankRadiusMm: 30, rodLengthMm: 100, mepBar: 8 })).toMatch(/displacementCm3/);
  });
});

const BORE_MM = 84;
function wiebeCylinder(overrides: Partial<Extract<CylinderPressure['model'], { kind: 'wiebe' }>> = {}): CylinderPressure {
  return {
    id: 'c',
    piston: 'slide_j',
    crank: 'crank_j',
    boreMm: BORE_MM,
    compressionRatio: 10.8,
    cycle: 'four_stroke',
    firingOffsetDeg: 0,
    tdcCrankAngleRad: null,
    ambientPressurePa: 101325,
    model: {
      kind: 'wiebe',
      startDeg: -15,
      durationDeg: 50,
      a: 5,
      m: 2,
      compressionIndex: 1.32,
      expansionIndex: 1.28,
      intakePressurePa: 95000,
      heat: { kind: 'per_cycle_J', value: 400 },
      ...overrides,
    },
  };
}

function geometryOf(cylinder: CylinderPressure, options = {}): ReturnType<typeof engineLayout> {
  const { doc } = sliderCrank({ rMm: 30.5, lMm: 130, ...options });
  const dynamics = { ...doc.dynamics!, cylinders: { c: cylinder } };
  const topology = buildTopology(dynamics);
  if ('error' in topology) throw new Error(topology.error);
  return engineLayout(dynamics, topology, cylinder, 0.001);
}

describe('engine geometry from the joints', () => {
  it('reads crank radius, rod length, stroke, displacement and the TDC crank angle', () => {
    const layout = geometryOf(wiebeCylinder(), { startDeg: 60 });
    if ('error' in layout) throw new Error(layout.error);
    expect(layout.slider.r).toBeCloseTo(0.0305, 12);
    expect(layout.slider.l).toBeCloseTo(0.13, 12);
    expect(layout.strokeM).toBeCloseTo(0.061, 12);
    expect(layout.displacementM3).toBeCloseTo((Math.PI * 0.084 ** 2 * 0.061) / 4, 12);
    expect(layout.clearanceVolumeM3).toBeCloseTo(layout.displacementM3 / 9.8, 15);
    // the crank pin starts 60 deg past the top and turns positively: the top comes 300 deg later
    expect(layout.topCrankAngleRad / DEG).toBeCloseTo(300, 9);
    expect(layout.headSign).toBe(1);
    expect(layout.offset).toBe(false);
    expect([layout.crankPinJoint, layout.wristJoint, layout.rodBody]).toEqual(['rod_j', 'wrist_j', 'rod']);
  });

  it('flags an offset cylinder and keeps the stroke at least 2 r', () => {
    const layout = geometryOf(wiebeCylinder(), { offsetMm: 8, startDeg: 20 });
    if ('error' in layout) throw new Error(layout.error);
    expect(layout.offset).toBe(true);
    expect(layout.strokeM).toBeGreaterThan(0.061 - 1e-9);
  });

  it('refuses a piston or crank that is not a tree joint of the right kind, and a missing rod', () => {
    expect(geometryOf({ ...wiebeCylinder(), crank: 'rod_j' })).toMatchObject({ error: expect.stringMatching(/no connecting rod/) });
    expect(geometryOf({ ...wiebeCylinder(), crank: 'wrist_j' }, { wrist: 'revolute' })).toMatchObject({
      error: expect.stringMatching(/'wrist_j' closes a loop/),
    });
    expect(geometryOf({ ...wiebeCylinder(), piston: 'crank_j' })).toMatchObject({ error: expect.stringMatching(/not a prismatic/) });
    expect(geometryOf({ ...wiebeCylinder(), crank: 'slide_j' })).toMatchObject({ error: expect.stringMatching(/not a revolute/) });
  });
});

describe('pressure models', () => {
  const layout = geometryOf(wiebeCylinder());
  if ('error' in layout) throw new Error(layout.error);

  it('table: periodic linear interpolation, work from the loop integral, coverage check (FPR_PRESSURE_TABLE_GAP)', () => {
    const cylinder: CylinderPressure = {
      ...wiebeCylinder(),
      model: {
        kind: 'table',
        points: [
          [0, 0],
          [360, 4e6],
          [720, 0],
        ],
      },
    };
    const curve = pressureCurve(cylinder, layout, 1000);
    if ('error' in curve) throw new Error(curve.error);
    expect(gaugeAt(curve, 180)).toBeCloseTo(2e6, 3);
    expect(gaugeAt(curve, 360 + 720)).toBeCloseTo(4e6, 3);
    expect(gaugeAt(curve, -360)).toBeCloseTo(4e6, 3);
    expect(curve.peakAngleDeg).toBeCloseTo(360, 6);
    expect(curve.peakPa).toBeCloseTo(4e6 + 101325, 3);
    const gap = pressureCurve(
      {
        ...cylinder,
        model: {
          kind: 'table',
          points: [
            [0, 0],
            [360, 4e6],
          ],
        },
      },
      layout,
      1000,
    );
    expect(gap).toMatchObject({ code: 'FPR_PRESSURE_TABLE_GAP' });
    expect(
      pressureCurve(
        {
          ...cylinder,
          cycle: 'two_stroke',
          model: {
            kind: 'table',
            points: [
              [0, 0],
              [360, 4e6],
            ],
          },
        },
        layout,
        1000,
      ),
    ).not.toHaveProperty('error');
    expect(
      pressureCurve(
        {
          ...cylinder,
          model: {
            kind: 'table',
            points: [
              [0, 0],
              [0, 1],
              [720, 0],
            ],
          },
        },
        layout,
        1000,
      ),
    ).toMatchObject({ code: 'FPR_PRESSURE_TABLE_GAP' });
  });

  it('wiebe: the pressure is linear in the heat released (calibration linearity)', () => {
    const at = (value: number): Float64Array => {
      const curve = pressureCurve(wiebeCylinder({ heat: { kind: 'per_cycle_J', value } }), layout, 1000);
      if ('error' in curve) throw new Error(curve.error);
      return curve.gaugePa;
    };
    const [zero, low, high, mid] = [at(1e-9), at(200), at(600), at(400)];
    let worst = 0;
    mid.forEach((p, k) => {
      const linear = (low[k] ?? 0) + (((high[k] ?? 0) - (low[k] ?? 0)) * (400 - 200)) / (600 - 200);
      worst = Math.max(worst, Math.abs(p - linear));
    });
    expect(worst).toBeLessThan(1e-6);
    expect(Math.max(...high)).toBeGreaterThan(Math.max(...zero));
  });

  it('wiebe: a target IMEP is met exactly, with a sensible peak pressure and the right gas exchange levels', () => {
    const target = 11.2477e5;
    const cylinder = wiebeCylinder({ heat: { kind: 'target_imep_Pa', value: target } });
    const curve = pressureCurve(cylinder, layout, 1000);
    if ('error' in curve) throw new Error(curve.error);
    expect(Math.abs(curve.imepPa - target) / target).toBeLessThan(1e-9);
    expect(curve.heatJ ?? 0).toBeGreaterThan(300);
    expect(curve.peakPa / 1e5).toBeGreaterThan(30);
    expect(curve.peakPa / 1e5).toBeLessThan(90);
    expect(curve.peakAngleDeg).toBeGreaterThan(0);
    expect(curve.peakAngleDeg).toBeLessThan(40);
    expect(gaugeAt(curve, 270)).toBeCloseTo(0, 6);
    expect(gaugeAt(curve, 450)).toBeCloseTo(95000 - 101325, 6);
  });

  it('wiebe: a target below the motored loop is refused (FPR_IMEP_UNREACHABLE)', () => {
    const refused = pressureCurve(wiebeCylinder({ heat: { kind: 'target_imep_Pa', value: -5e5 } }), layout, 1000);
    expect(refused).toMatchObject({ code: 'FPR_IMEP_UNREACHABLE' });
  });

  it('single zone: heat loss lowers the peak against the lossless Wiebe, and calibration table interpolates in rpm', () => {
    const single: CylinderPressure = {
      ...wiebeCylinder(),
      model: {
        kind: 'single_zone',
        burn: { ca50Deg: 9, durationDeg: 35, a: 5, m: 2, rpmExponent: 0.2 },
        woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.00324, tempExponent: -0.53, wallTempK: 450 },
        intakePressurePa: 95000,
        intakeTempK: 330,
        heat: {
          kind: 'table_vs_rpm',
          points: [
            [1000, 400],
            [5000, 600],
          ],
        },
      },
    };
    const slow = pressureCurve(single, layout, 1000);
    const fast = pressureCurve(single, layout, 5000);
    const lossless = pressureCurve(wiebeCylinder({ heat: { kind: 'per_cycle_J', value: 400 } }), layout, 1000);
    if ('error' in slow || 'error' in fast || 'error' in lossless) throw new Error('curve refused');
    expect(slow.heatJ).toBeCloseTo(400, 9);
    expect(fast.heatJ).toBeCloseTo(600, 9);
    expect(slow.peakPa).toBeLessThan(lossless.peakPa * 1.2);
    expect(slow.imepPa / 1e5).toBeGreaterThan(3);
    expect(fast.imepPa).toBeGreaterThan(slow.imepPa);
    expect(slow.peakAngleDeg).toBeGreaterThan(0);
    expect(slow.peakAngleDeg).toBeLessThan(40);
  });

  it('single zone: a burn outside the stroke is refused with a reason', () => {
    const single: CylinderPressure = {
      ...wiebeCylinder(),
      model: {
        kind: 'single_zone',
        burn: { ca50Deg: 170, durationDeg: 35, a: 5, m: 2, rpmExponent: 0.2 },
        woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.00324, tempExponent: -0.53, wallTempK: 450 },
        intakePressurePa: 95000,
        intakeTempK: 330,
        heat: { kind: 'per_cycle_J', value: 400 },
      },
    };
    expect(pressureCurve(single, layout, 3000)).toMatchObject({ code: 'FPR_PRESSURE_MODEL_INVALID' });
  });

  it('model checks: firing offset on a TDC crossing, combustion inside the stroke, indices above 1', () => {
    expect(modelProblem({ ...wiebeCylinder(), firingOffsetDeg: 90 })).toMatch(/TDC/);
    expect(modelProblem({ ...wiebeCylinder(), firingOffsetDeg: 360 })).toBeNull();
    expect(modelProblem(wiebeCylinder({ startDeg: 170, durationDeg: 30 }))).toMatch(/inside the compression-expansion/);
    expect(modelProblem(wiebeCylinder({ compressionIndex: 1 }))).toMatch(/> 1/);
  });
});

describe('add_cylinder_pressure', () => {
  const base = (): CadDocument => sliderCrank({ rMm: 30.5, lMm: 130, startDeg: 40 }).doc;
  const wiebe = {
    kind: 'wiebe',
    startDeg: -15,
    durationDeg: 50,
    a: 5,
    m: 2,
    compressionIndex: 1.32,
    expansionIndex: 1.28,
    intakePressurePa: 95000,
    heat: { kind: 'target_imep_Pa', value: 1.1e6 },
  };
  const params = { piston: 'slide_j', crank: 'crank_j', boreMm: 84, compressionRatio: 10.8, model: wiebe };

  it('adds a step-scoped cylinder id and reports the geometry, peak pressure and IMEP; the input is untouched', () => {
    const doc = base();
    const before = structuredClone(doc);
    const result = execute(doc, 'add_cylinder_pressure', params);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toMatch(/^cyl-.+\.1$/);
    expect(result.summary).toMatch(/crank radius 30\.500 mm, rod 130\.00 mm, stroke 61\.000 mm/);
    expect(result.summary).toMatch(/TDC at crank 320\.00 deg/);
    expect(result.summary).toMatch(/net IMEP 11\.00 bar/);
    expect(result.summary).toMatch(/Unverified/);
    expect(doc).toEqual(before);
    const stored = result.document.dynamics?.cylinders?.[result.affected[0] ?? ''];
    expect(stored).toMatchObject({ cycle: 'four_stroke', firingOffsetDeg: 0, ambientPressurePa: 101325, tdcCrankAngleRad: null });
    // quick check reads the same geometry and pressure back
    const data = quick(result.document, { cylinder: result.affected[0], anglesDeg: [0, 180, 360], rpm: 3000 });
    expect(data.cylinder?.imepBar).toBeCloseTo(11, 6);
    expect(data.mean?.meanTorqueNm).toBeCloseTo((11e5 * ((Math.PI * 0.084 ** 2 * 0.061) / 4)) / (4 * Math.PI), 6);
    expect(data.angles[1]?.gaugeBar).toBeDefined();
  });

  it('single_zone defaults are stored and a two-stroke / explicit TDC is honoured', () => {
    const single = {
      kind: 'single_zone',
      burn: { ca50Deg: 9, durationDeg: 35, a: 5, m: 2 },
      intakePressurePa: 95000,
      intakeTempK: 330,
      heat: { kind: 'per_cycle_J', value: 400 },
      source: 'test',
    };
    const result = execute(base(), 'add_cylinder_pressure', { ...params, model: single, cycle: 'two_stroke', tdcCrankAngleDeg: 12 });
    const stored = result.document.dynamics?.cylinders?.[result.affected[0] ?? ''];
    expect(stored?.model).toMatchObject({
      woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.00324, tempExponent: -0.53, wallTempK: 450 },
      burn: { rpmExponent: 0.2 },
    });
    expect(stored?.tdcCrankAngleRad).toBeCloseTo(12 * DEG, 12);
    expect(result.summary).not.toMatch(/Unverified/);
  });

  it('refuses bad joints, models and coverage without changing the document', () => {
    const doc = base();
    const run = (patch: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(doc, 'add_cylinder_pressure', { ...params, ...patch });
    expect(run({ piston: 'ghost' }).summary).toMatch(/not found/);
    expect(run({ piston: 'crank_j' }).summary).toMatch(/must be a prismatic/);
    expect(run({ crank: 'ghost' }).summary).toMatch(/not found/);
    expect(run({ crank: 'slide_j' }).summary).toMatch(/must be a revolute/);
    expect(run({ compressionRatio: 1 }).summary).toMatch(/rejected/);
    expect(run({ boreMm: -1 }).summary).toMatch(/rejected/);
    expect(run({ firingOffsetDeg: 90 }).summary).toMatch(/TDC crossing/);
    expect(run({ model: { ...wiebe, compressionIndex: undefined } }).summary).toMatch(/compressionIndex and expansionIndex/);
    expect(run({ model: { ...wiebe, heat: undefined } }).summary).toMatch(/heat/);
    expect(run({ model: { ...wiebe, intakePressurePa: undefined } }).summary).toMatch(/intakePressurePa/);
    expect(run({ model: { kind: 'table', points: [[0, 0]] } }).summary).toMatch(/at least 2/);
    expect(run({ model: { kind: 'single_zone', intakePressurePa: 1e5 } }).summary).toMatch(/needs burn/);
    expect(
      run({
        model: {
          kind: 'single_zone',
          intakePressurePa: 1e5,
          intakeTempK: 300,
          burn: { durationDeg: 30, a: 5, m: 2 },
          heat: { kind: 'per_cycle_J', value: 1 },
        },
      }).summary,
    ).toMatch(/exactly one of ca50Deg and startDeg/);
    expect(
      run({ model: { kind: 'single_zone', intakePressurePa: 1e5, intakeTempK: 300, burn: { ca50Deg: 9, durationDeg: 30, a: 5, m: 2 } } })
        .summary,
    ).toMatch(/needs heat/);
    expect(
      run({
        model: {
          kind: 'single_zone',
          intakePressurePa: 1e5,
          burn: { ca50Deg: 9, durationDeg: 30, a: 5, m: 2 },
          heat: { kind: 'per_cycle_J', value: 1 },
        },
      }).summary,
    ).toMatch(/intakeTempK/);
    expect(run({ model: { ...wiebe, startDeg: 170 } }).summary).toMatch(/inside the compression-expansion/);
    const gap = run({
      model: {
        kind: 'table',
        points: [
          [0, 0],
          [360, 1e6],
        ],
      },
    });
    expect(gap.summary).toMatch(/FPR_PRESSURE_TABLE_GAP/);
    expect(gap.error?.code).toBe('FPR_PRESSURE_TABLE_GAP');
    const unreachable = run({
      model: { ...wiebe, compressionIndex: 1.4, expansionIndex: 1.2, heat: { kind: 'target_imep_Pa', value: 1e3 } },
    });
    expect(unreachable.summary).toMatch(/FPR_IMEP_UNREACHABLE/);
    expect(unreachable.affected).toEqual([]);
    expect(unreachable.document).toBe(doc);
  });

  it('allows one pressure per piston and shares the dynamics id space', () => {
    const first = execute(base(), 'add_cylinder_pressure', { ...params, id: 'cyl_a' });
    expect(execute(first.document, 'add_cylinder_pressure', { ...params, id: 'cyl_b' }).summary).toMatch(
      /already has cylinder pressure 'cyl_a'/,
    );
    const clash = execute(base(), 'add_cylinder_pressure', { ...params, id: 'crank' });
    expect(clash.summary).toMatch(/already used/);
  });

  it('delete_dynamics_item removes the cylinder with its piston joint', () => {
    const added = execute(base(), 'add_cylinder_pressure', { ...params, id: 'cyl_a' });
    const removed = execute(added.document, 'delete_dynamics_item', { id: 'slide_j' });
    expect(removed.document.dynamics?.cylinders).toEqual({});
    expect(removed.summary).toMatch(/dependent record/);
    expect(execute(added.document, 'delete_dynamics_item', { id: 'cyl_a' }).document.dynamics?.cylinders).toEqual({});
  });

  it('accepts a declaration before the rod exists and reports that the geometry is read later', () => {
    const noRod = { ...sliderCrank().doc };
    const dynamics = {
      ...noRod.dynamics!,
      joints: Object.fromEntries(Object.entries(noRod.dynamics!.joints).filter(([id]) => id !== 'wrist_j' && id !== 'rod_j')),
    };
    const result = execute({ ...noRod, dynamics }, 'add_cylinder_pressure', params);
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toMatch(/geometry not usable yet \(no connecting rod/);
  });
});
