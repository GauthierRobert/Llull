/** PHY-21 slice B data: spherical joints, shared children, solver settings and cylinder pressures survive save / load and replay. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { createDynamicsModel } from '@core/model/dynamics';
import { resolveTimestep } from '@core/dynamics/timestep';
import { DEFAULT_SOLVER_SETTINGS } from '@core/model/dynamics';
import { sliderCrank } from './sliderCrankFixture';

describe('dynamics persistence with loops', () => {
  it('round-trips a slider-crank with a spherical wrist, a gap pin and solver settings', () => {
    const base = sliderCrank({ wristGapMm: 0.5 }).doc;
    const doc = execute(base, 'set_dynamics_solver', { timestepS: 2e-5, loopTimeConstantSteps: 3 }).document;
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.dynamics).toEqual(doc.dynamics);
    expect(loaded.dynamics?.joints['wrist_j']).toMatchObject({ kind: 'spherical', anchorOnChild: [expect.any(Number), 0.5, 0] });
    expect(loaded.dynamics?.solver).toMatchObject({ timestepS: 2e-5, loopTimeConstantSteps: 3, loopImpedance: 0.9999 });
  });

  it('a document saved before PHY-21 (no cylinders, no solver) loads unchanged', () => {
    const { doc } = sliderCrank();
    expect(doc.dynamics?.cylinders).toBeUndefined();
    expect(doc.dynamics?.solver).toBeUndefined();
    expect(deserializeDocument(serializeDocument(doc)).dynamics).toEqual(doc.dynamics);
    expect(dynamicsProblems(createDynamicsModel())).toEqual([]);
  });

  it('rejects malformed new fields on load', () => {
    const { doc } = sliderCrank();
    const dynamics = JSON.parse(JSON.stringify(doc.dynamics)) as Record<string, unknown>;
    const problems = (patch: Record<string, unknown>): string[] => dynamicsProblems({ ...dynamics, ...patch });
    expect(problems({ solver: { ...DEFAULT_SOLVER_SETTINGS, loopTimeConstantSteps: 1 } })[0]).toMatch(
      /dynamics\.solver: loopTimeConstantSteps/,
    );
    expect(problems({ solver: { ...DEFAULT_SOLVER_SETTINGS, loopImpedance: 1 } })[0]).toMatch(/loopImpedance/);
    expect(problems({ solver: { ...DEFAULT_SOLVER_SETTINGS, integrator: 'euler' } })[0]).toMatch(/integrator/);
    expect(problems({ solver: { ...DEFAULT_SOLVER_SETTINGS, loopResidualFailM: 0 } })[0]).toMatch(/loopResidual/);
    expect(problems({ solver: 3 })[0]).toMatch(/solver must be an object/);
    expect(problems({ solver: { ...DEFAULT_SOLVER_SETTINGS } })).toEqual([]);
    const joints = dynamics['joints'] as Record<string, Record<string, unknown>>;
    expect(problems({ joints: { ...joints, wrist_j: { ...joints['wrist_j'], damping: 1 } } })[0]).toMatch(/spherical joint has damping/);
    expect(problems({ joints: { ...joints, wrist_j: { ...joints['wrist_j'], anchorOnChild: [1, 2] } } })[0]).toMatch(/anchorOnChild/);
    expect(problems({ joints: { ...joints, wrist_j: { ...joints['wrist_j'], kind: 'ball' } } })[0]).toMatch(/spherical/);
  });
});

describe('set_dynamics_solver', () => {
  it('changes only the given fields, is pure, and refuses empty or inverted tiers', () => {
    const { doc } = sliderCrank();
    const before = structuredClone(doc);
    const first = execute(doc, 'set_dynamics_solver', { loopImpedance: 0.99 });
    const second = execute(first.document, 'set_dynamics_solver', { integrator: 'implicitfast' });
    expect(doc).toEqual(before);
    expect(second.document.dynamics?.solver).toEqual({ ...DEFAULT_SOLVER_SETTINGS, loopImpedance: 0.99, integrator: 'implicitfast' });
    expect(execute(doc, 'set_dynamics_solver', {}).summary).toMatch(/at least one/);
    expect(execute(doc, 'set_dynamics_solver', { loopResidualPassM: 1e-3 }).summary).toMatch(/must not exceed/);
    expect(execute(doc, 'set_dynamics_solver', { loopTimeConstantSteps: 1 }).summary).toMatch(/rejected/);
    expect(execute(doc, 'set_dynamics_solver', { loopImpedance: 1 }).summary).toMatch(/rejected/);
    const restored = execute(second.document, 'set_dynamics_solver', { loopImpedance: 0.9999, integrator: 'rk4' });
    expect(restored.summary).toMatch(/the defaults/);
  });
});

describe('timestep resolution', () => {
  const { doc } = sliderCrank({ crankRpm: 5800 });
  const dynamics = doc.dynamics!;
  const pilot = (): number => 600;

  it('legacy 1 ms without loops or cylinders, the request otherwise', () => {
    expect(resolveTimestep(dynamics, DEFAULT_SOLVER_SETTINGS, undefined, false, pilot).timestep).toBe(0.001);
    expect(resolveTimestep(dynamics, DEFAULT_SOLVER_SETTINGS, 5e-5, true, pilot)).toMatchObject({
      timestep: 5e-5,
      basis: 'requested by the call',
    });
  });

  it('auto: 0.5 deg of crank at the announced speed (14.4 us at 5800 rpm), a stored value wins over auto', () => {
    const auto = resolveTimestep(dynamics, DEFAULT_SOLVER_SETTINGS, undefined, true, pilot);
    expect(auto.timestep).toBeCloseTo((0.5 * Math.PI) / 180 / ((5800 * 2 * Math.PI) / 60), 12);
    expect(auto.timestep * 1e6).toBeCloseTo(14.37, 1);
    expect(resolveTimestep(dynamics, { ...DEFAULT_SOLVER_SETTINGS, timestepS: 3e-5 }, undefined, true, pilot).timestep).toBe(3e-5);
  });

  it('auto with no announced speed uses the pilot run (x1.2), capped at 1 ms and floored at 10 us', () => {
    const idle = {
      ...dynamics,
      joints: Object.fromEntries(Object.entries(dynamics.joints).map(([id, j]) => [id, { ...j, initialVelocity: 0 }])),
    };
    const slow = resolveTimestep(idle, DEFAULT_SOLVER_SETTINGS, undefined, true, () => 1);
    expect(slow.timestep).toBe(0.001);
    expect(slow.basis).toMatch(/pilot/);
    expect(resolveTimestep(idle, DEFAULT_SOLVER_SETTINGS, undefined, true, () => 600).timestep).toBeCloseTo(
      (0.5 * Math.PI) / 180 / 720,
      12,
    );
    expect(resolveTimestep(idle, DEFAULT_SOLVER_SETTINGS, undefined, true, () => 1e6).timestep).toBe(1e-5);
    expect(resolveTimestep(idle, DEFAULT_SOLVER_SETTINGS, undefined, true, () => 0).timestep).toBe(0.001);
  });
});

describe('cylinder pressures as document data', () => {
  const table = {
    kind: 'table',
    points: [
      [0, 0],
      [360, 3e6],
      [720, 0],
    ],
    source: 'test',
  };
  const single = {
    kind: 'single_zone',
    burn: { ca50Deg: 9, durationDeg: 35, a: 5, m: 2, rpmExponent: 0.2 },
    woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.00324, tempExponent: -0.53, wallTempK: 450 },
    intakePressurePa: 95000,
    intakeTempK: 330,
    heat: {
      kind: 'table_vs_rpm',
      points: [
        [1000, 300],
        [5000, 500],
      ],
    },
  };
  const wiebe = {
    kind: 'wiebe',
    startDeg: -15,
    durationDeg: 50,
    a: 5,
    m: 2,
    compressionIndex: 1.3,
    expansionIndex: 1.3,
    intakePressurePa: 95000,
    heat: { kind: 'target_imep_Pa', value: 1e6 },
  };

  function withCylinders(): ReturnType<typeof sliderCrank>['doc'] {
    const { doc } = sliderCrank({ rMm: 30.5, lMm: 130 });
    const first = execute(doc, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: 84,
      compressionRatio: 10,
      model: table,
      id: 'c_table',
    });
    return first.document;
  }

  it('round-trips table, wiebe and single_zone models through save / load and history replay', () => {
    const { doc } = sliderCrank({ rMm: 30.5, lMm: 130 });
    for (const [id, model] of [
      ['c_table', table],
      ['c_wiebe', wiebe],
      ['c_single', single],
    ] as const) {
      const alone = execute(doc, 'add_cylinder_pressure', {
        piston: 'slide_j',
        crank: 'crank_j',
        boreMm: 84,
        compressionRatio: 10,
        model,
        id,
      });
      expect(alone.affected).toEqual([id]);
      const loaded = deserializeDocument(serializeDocument(alone.document));
      expect(loaded.dynamics).toEqual(alone.document.dynamics);
      expect(loaded.dynamics?.cylinders?.[id]?.model.kind).toBe(model.kind);
      expect(dynamicsProblems(loaded.dynamics)).toEqual([]);
    }
    const replayed = execute(withCylinders(), 'replay_history', {}).document;
    expect(replayed.dynamics).toEqual(withCylinders().dynamics);
  });

  it('rejects malformed cylinders on load', () => {
    const dynamics = JSON.parse(JSON.stringify(withCylinders().dynamics)) as {
      cylinders: Record<string, Record<string, unknown>>;
    } & Record<string, unknown>;
    const problems = (patch: Record<string, unknown>): string[] =>
      dynamicsProblems({ ...dynamics, cylinders: { c_table: { ...dynamics.cylinders['c_table'], ...patch } } });
    expect(problems({})).toEqual([]);
    expect(problems({ piston: 3 })[0]).toMatch(/piston and crank/);
    expect(problems({ compressionRatio: 1 })[0]).toMatch(/compressionRatio > 1/);
    expect(problems({ cycle: 'diesel' })[0]).toMatch(/cycle/);
    expect(problems({ ambientPressurePa: 0 })[0]).toMatch(/ambientPressurePa/);
    expect(problems({ tdcCrankAngleRad: 'x' })[0]).toMatch(/tdcCrankAngleRad/);
    expect(problems({ model: 4 })[0]).toMatch(/model must be an object/);
    expect(problems({ model: { kind: 'table', points: [[0, 1]] } })[0]).toMatch(/at least 2/);
    expect(problems({ model: { kind: 'wiebe' } })[0]).toMatch(/wiebe needs heat/);
    expect(problems({ model: { ...wiebe, a: -1 } })[0]).toMatch(/wiebe needs finite/);
    expect(problems({ model: { kind: 'single_zone' } })[0]).toMatch(/single_zone burn/);
    expect(problems({ model: { ...single, burn: { durationDeg: 30, a: 5, m: 2, rpmExponent: 0.2 } } })[0]).toMatch(/ca50Deg or startDeg/);
    expect(problems({ model: { ...single, woschni: {} } })[0]).toMatch(/woschni needs/);
    expect(
      problems({
        model: {
          ...single,
          woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.003, tempExponent: -0.5, wallTempK: 450 },
          intakeTempK: 0,
        },
      })[0],
    ).toMatch(/intakeTempK/);
    expect(
      problems({
        model: {
          ...single,
          woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.003, tempExponent: -0.5, wallTempK: 450 },
          heat: { kind: 'x' },
        },
      })[0],
    ).toMatch(/single_zone heat/);
    expect(problems({ model: { kind: 'plasma' } })[0]).toMatch(/model.kind/);
  });
});
