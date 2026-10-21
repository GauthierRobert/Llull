/**
 * Edge cases of the M3b realism laws on MuJoCo: a two-stroke friction torque, a loss record whose cylinder is gone, engines without losses
 * (indicated torque in the convergence check, table pressure as `input`), and a propeller that is not coupled to the crank.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { EngineData } from '@dynamics/sim/engineReport';
import type { RealismData } from '@dynamics/sim/engine/engineRealism';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { step } from './engineRealismFixture';
import { sliderCrank } from './sliderCrankFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

type Run = { engineReport?: EngineData & { realism?: RealismData }; warnings: string[] };

const FMEP_TABLE = {
  kind: 'fmep_table',
  points: [
    [1000, 1e5],
    [6000, 1e5],
  ],
  source: 'test: constant 1 bar',
};

/** Crank at 3000 rpm with one table-pressure cylinder; `cycle` selects the table coverage. */
function tableEngine(cycle: 'four_stroke' | 'two_stroke', losses: boolean): CadDocument {
  const { doc } = sliderCrank({ rMm: 30.5, lMm: 130, crankRpm: 3000, crankInertia: 0.2, pistonKg: 0.4, rodKg: 0.4, startDeg: 25 });
  let d = execute(doc, 'set_gravity', { gravity: [0, 0, 0] }).document;
  if (losses) d = step(d, 'set_engine_losses', { crank: 'crank_j', model: FMEP_TABLE }).doc;
  const length = cycle === 'four_stroke' ? 720 : 360;
  d = step(d, 'add_cylinder_pressure', {
    piston: 'slide_j',
    crank: 'crank_j',
    boreMm: 84,
    compressionRatio: 10.8,
    cycle,
    model: {
      kind: 'table',
      // a firing peak at TDC that falls through the power stroke, quiet gas exchange, and a compression rise back to the peak
      points: [
        [0, 3e6],
        [length / 8, 1.2e6],
        [length / 4, 2e5],
        [length / 2, 0],
        [(3 * length) / 4, 0],
        [(7 * length) / 8, 3e5],
        [length, 3e6],
      ],
      source: 'test table',
    },
  }).doc;
  return step(d, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: 3000, maxTorque: 1e6 }).doc;
}

function simulate(doc: CadDocument, params: Record<string, unknown>): Run {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Run;
}

describe('engine losses edge cases', () => {
  it('a two-stroke friction torque is FMEP · V_d / (2 pi) per revolution, and the table pressure is an input', () => {
    const data = simulate(tableEngine('two_stroke', true), { duration: 0.08 });
    const losses = data.engineReport?.realism?.losses;
    const displacement = (Math.PI / 4) * 0.084 ** 2 * (2 * 0.0305);
    expect(losses?.fmepBar).toBeCloseTo(1, 9);
    expect(losses?.frictionTorqueNm).toBeCloseTo((1e5 * displacement) / (2 * Math.PI), 6);
    expect(data.engineReport?.realism?.accuracy['meanTorqueNm']).toMatchObject({ origin: 'input', band: null });
    expect(data.engineReport?.realism?.accuracy['fmepBar']).toMatchObject({ origin: 'input', band: null });
    expect(data.engineReport?.realism?.accuracy['brakeTorqueNm']?.band).toBeNull();
    // only the efficiency band speaks: a table has no burn phasing to judge
    expect(data.engineReport?.realism?.plausibility.map((finding) => finding.quantity)).not.toContain('ca50');
  });

  it('a loss record whose cylinder was deleted applies no friction and reports no loss block', () => {
    const doc = tableEngine('four_stroke', false);
    const listed = step(doc, 'set_engine_losses', {
      crank: 'crank_j',
      model: FMEP_TABLE,
      cylinders: [Object.keys(doc.dynamics?.cylinders ?? {})[0] ?? ''],
    });
    const cylinder = Object.keys(listed.doc.dynamics?.cylinders ?? {})[0] ?? '';
    const stale = execute(listed.doc, 'delete_dynamics_item', { id: cylinder }).document;
    expect(Object.keys(stale.dynamics?.losses ?? {})).toHaveLength(1);
    const result = execute(stale, 'simulate_motion', { duration: 0.1 });
    expect(result.rejected).toBeUndefined();
    expect((result.data as Run).engineReport).toBeUndefined();
  });

  it('check_timestep_convergence reports the indicated torque when there are no losses', () => {
    const result = execute(tableEngine('four_stroke', false), 'check_timestep_convergence', { cycles: 1 });
    const data = result.data as { torqueKind: string; status: string; meanTorqueNm: { change: number } };
    expect(data.torqueKind).toBe('indicated');
    expect(data.meanTorqueNm.change).toBeLessThan(0.01);
    expect(data.status).toBe('pass');
    expect(result.summary).toMatch(/check_timestep_convergence: pass/);
  });
});

describe('compare_to_reference edge cases', () => {
  it('a propeller that no gear couples to the crank is a not_run item, not a guess', () => {
    let d = tableEngine('four_stroke', true);
    const disc = step(d, 'add_cylinder', { radius: 100, height: 10, axis: [0, 0, 1], position: [0, 300, 0] });
    d = step(disc.doc, 'add_rigid_body', { entityIds: [disc.id], massKg: 0.5, id: 'prop' }).doc;
    d = step(d, 'add_body_joint', { kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 0, 1], id: 'prop_j' }).doc;
    d = step(d, 'add_propeller', { joint: 'prop_j', diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 }).doc;
    d = step(d, 'add_reference_data', { quantity: 'propeller_rpm', points: [{ value: 2000 }], source: 'synthetic', id: 'loose' }).doc;
    const run = execute(d, 'compare_to_reference', { reference: 'loose', durationS: 0.3 });
    const items = (run.data as { items: { status: string; unverified?: boolean }[]; status: string }).items;
    expect(items[0]).toMatchObject({ status: 'not_run', unverified: true });
    expect((run.data as { status: string }).status).toBe('not_run');
  });

  it('a speed outside the friction table is flagged FPR_OUTSIDE_VALIDATED_RANGE on the point', () => {
    let d = tableEngine('four_stroke', true);
    d = step(d, 'add_reference_data', {
      quantity: 'brake_torque_Nm',
      points: [{ rpm: 500, value: 20, uncertainty: 1 }],
      source: 'synthetic',
      id: 'slow',
      grade: 'C',
    }).doc;
    const run = execute(d, 'compare_to_reference', { reference: 'slow', timestepHalving: false, cycles: 1 });
    const items = (run.data as { items: { code: string; status: string }[] }).items;
    expect(items.map((item) => item.code)).toContain('FPR_OUTSIDE_VALIDATED_RANGE');
    expect(items.find((item) => item.code === 'FPR_OUTSIDE_VALIDATED_RANGE')?.status).toBe('warn');
    expect((run.data as { points: { status: string; code: string | null }[] }).points[0]?.status).toBe('warn');
  });
});
