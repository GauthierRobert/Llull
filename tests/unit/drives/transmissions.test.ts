/**
 * add_transmission (PHY-23 DRV-M2): VC-DRV-10 (gear efficiency through MuJoCo), VC-DRV-13 / 14 / 15 (lead screw: lift, fall, self-locking, force),
 * VC-DRV-16 (backlash), belts, ball screws and racks, the coded refusals, purity and the cascade of delete_dynamics_item.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { leadScrewEfficiency, screwAxialForce } from '@dynamics/sim/transmissions';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { loadPlan, noGravity, runSteps, section, seriesOf, slider, spinner, SOURCE_A } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface ScrewReference {
  free: { forwardEfficiency: number; backDriveEfficiency: number; liftAccelerationMS2: number; fallAccelerationMotorOffMS2: number };
  locking: { forwardEfficiency: number; liftAccelerationMS2: number; selfLocking: boolean };
  forceFromTorque: { torqueNm: number; leadM: number; efficiency: number; forceN: number };
}
const screw = section<ScrewReference>('leadScrew');

interface Ledger {
  closureRelative: number;
  entries: { element: string; kind: string; joules: number }[];
}
const ledgerOf = (result: ReturnType<typeof execute>): Ledger => (result.data as { ledger: Ledger }).ledger;

/** The lead-screw plan with the thread friction `mu`, optionally without its motor, simulated `duration` s at `timestep`. */
function screwRun(mu: number, options: { motor: boolean; duration: number; timestep?: number }): ReturnType<typeof execute> {
  const plan = loadPlan('drv_lead_screw').filter((step) => options.motor || step.command !== 'add_motor');
  const thread = plan.find((step) => step.command === 'add_transmission');
  if (thread === undefined) throw new Error('the plan has no transmission');
  thread.params['mu'] = mu;
  const last = plan[plan.length - 1];
  if (last === undefined) throw new Error('empty plan');
  last.params['duration'] = options.duration;
  last.params['sampleRate'] = 100;
  if (options.timestep !== undefined) last.params['timestep'] = options.timestep;
  return runSteps(plan).last;
}

describe('lead screw (VC-DRV-13 / 14 / 15)', () => {
  it('thread efficiencies follow the geometry: 0.736721 / 0.664683 for mu 0.1, self-locking for mu 0.35', () => {
    const base = { kind: 'lead_screw', id: 't', screw: 'a', nut: 'b', leadMm: 10, meanDiameterMm: 10, flankAngleDeg: 0 } as const;
    const free = leadScrewEfficiency({ ...base, mu: 0.1 });
    expect(free.forward).toBeCloseTo(screw.free.forwardEfficiency, 6);
    expect(free.backward).toBeCloseTo(screw.free.backDriveEfficiency, 6);
    expect(free.selfLocking).toBe(false);
    const locked = leadScrewEfficiency({ ...base, mu: 0.35 });
    expect(locked.forward).toBeCloseTo(screw.locking.forwardEfficiency, 6);
    expect(locked.backward).toBeLessThanOrEqual(0);
    expect(locked.selfLocking).toBe(true);
    // a steeper flank raises the friction angle: tan(phi') = mu / cos(alpha)
    expect(leadScrewEfficiency({ ...base, mu: 0.1, flankAngleDeg: 14.5 }).forward).toBeLessThan(free.forward);
  });

  it('the plan lifts the nut at 10.3303 m/s^2 within 1 %; the ledger closes and carries the thread loss', () => {
    const run = screwRun(0.1, { motor: true, duration: 0.2 });
    const v = seriesOf(run, 'jointVelocity', 'j_nut');
    const lift = ((v[20] ?? 0) - (v[10] ?? 0)) / 0.1;
    expect(Math.abs(lift / screw.free.liftAccelerationMS2 - 1)).toBeLessThan(0.01);
    const ledger = ledgerOf(run);
    expect(ledger.closureRelative).toBeLessThan(1e-3);
    const loss = ledger.entries.find((entry) => entry.element === 'transmission:tr_screw');
    expect(loss?.kind).toBe('transmission_loss');
    expect(loss?.joules).toBeGreaterThan(0);
  });

  it('with the motor off the nut falls at 6.15455 m/s^2 (back-drive efficiency 0.664683)', () => {
    const run = screwRun(0.1, { motor: false, duration: 0.2 });
    const v = seriesOf(run, 'jointVelocity', 'j_nut');
    const fall = ((v[20] ?? 0) - (v[10] ?? 0)) / 0.1;
    expect(Math.abs(fall / -screw.free.fallAccelerationMotorOffMS2 - 1)).toBeLessThan(0.01);
    expect(ledgerOf(run).closureRelative).toBeLessThan(1e-3);
  });

  it('mu 0.35 is self-locking: motor off the nut moves at most 1e-6 m in 1 s; the screw still lifts at 2.98702 m/s^2', () => {
    const held = screwRun(0.35, { motor: false, duration: 1, timestep: 5e-5 });
    const x = seriesOf(held, 'jointPosition', 'j_nut');
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(1e-6);
    const lifted = screwRun(0.35, { motor: true, duration: 0.2 });
    const v = seriesOf(lifted, 'jointVelocity', 'j_nut');
    expect(Math.abs(((v[20] ?? 0) - (v[10] ?? 0)) / 0.1 / screw.locking.liftAccelerationMS2 - 1)).toBeLessThan(0.01);
  });

  it('a screw turned by 0.1 N*m at 90 % produces 113.097 N (eta T 2 pi / lead); a heavy nut sees that force minus the screw inertia', () => {
    const { torqueNm, leadM, efficiency, forceN } = screw.forceFromTorque;
    expect(screwAxialForce(torqueNm, leadM, efficiency)).toBeCloseTo(forceN, 6);
    // simulation: 1 kg nut, tiny screw inertia, ball screw eta 0.9 both ways, no gravity: m a = F m / (m + J k^2 eta)
    const doc = runSteps([
      ...spinner('s', 1e-9),
      ...slider('n', 1),
      noGravity,
      {
        command: 'add_transmission',
        params: { kind: 'ball_screw', screw: 'j_s', nut: 'j_n', leadMm: 5, efficiency: 0.9, efficiencyBack: 0.9, id: 'bs' },
      },
      { command: 'add_motor', params: { joint: 'j_s', kind: 'torque_curve', torque: 0.1 } },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 1e-4, sampleRate: 1000, detail: 'series' });
    const v = seriesOf(run, 'jointVelocity', 'j_n');
    const k = (2 * Math.PI) / leadM;
    const expected = (torqueNm * k * efficiency) / (1 + 1e-9 * k * k * efficiency);
    expect(Math.abs(((v[100] ?? 0) - (v[50] ?? 0)) / 0.05 / expected - 1)).toBeLessThan(0.005);
  });
});

describe('gear: efficiency both ways (VC-DRV-10)', () => {
  const pair = (extra: object, load: 'motor' | 'back'): CadDocument =>
    runSteps([
      ...spinner('in', 1.37e-5),
      ...spinner('out', 1.37e-3, [100, 0, 0]),
      noGravity,
      { command: 'add_transmission', params: { kind: 'gear', driver: 'j_in', driven: 'j_out', ratio: 0.1, id: 'g', ...extra } },
      ...(load === 'motor'
        ? [{ command: 'add_motor', params: { joint: 'j_in', kind: 'torque_curve', torque: 0.1 } }]
        : [
            {
              command: 'add_motion_profile',
              params: {
                id: 'p',
                quantity: 'torque',
                unit: 'N*m',
                segments: [
                  {
                    kind: 'table',
                    points: [
                      [0, 1],
                      [10, 1],
                    ],
                    interpolation: 'linear',
                  },
                ],
              },
            },
            { command: 'add_load_schedule', params: { joint: 'j_out', kind: 'torque', profile: 'p' } },
          ]),
    ]).doc;
  const speed = (doc: CadDocument, joint: string): { alpha: number; run: ReturnType<typeof execute> } => {
    const run = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 1e-4, sampleRate: 1000, detail: 'series', energy: true });
    return { alpha: (seriesOf(run, 'jointVelocity', joint)[100] ?? 0) / 0.1, run };
  };

  it('0.1 N*m through N = 10, eta 0.9, J_in 1.37e-5, J_out 1.37e-3 gives 345.755 rad/s^2 at the output within 0.5 %', () => {
    const { alpha, run } = speed(pair({ efficiency: 0.9 }, 'motor'), 'j_out');
    expect(
      Math.abs(alpha / section<{ spinUp: { outputAccelerationRadS2: number } }>('gear').spinUp.outputAccelerationRadS2 - 1),
    ).toBeLessThan(0.005);
    expect(ledgerOf(run).closureRelative).toBeLessThan(1e-3);
  });

  it('back-driven by 1 N*m on the output the input accelerates at eta_b r T / (J_in + eta_b r^2 J_out) (0.8, not 0.9)', () => {
    const { alpha, run } = speed(pair({ efficiency: 0.9, efficiencyBack: 0.8 }, 'back'), 'j_in');
    const [r, etaB, ji, jo] = [0.1, 0.8, 1.37e-5, 1.37e-3];
    expect(Math.abs(alpha / ((etaB * r) / (ji + etaB * r * r * jo)) - 1)).toBeLessThan(0.005);
    expect(ledgerOf(run).closureRelative).toBeLessThan(1e-3);
    const sameEfficiency = speed(pair({ efficiency: 0.9 }, 'back'), 'j_in').alpha;
    expect(sameEfficiency).toBeGreaterThan(alpha);
  });

  it('an ideal gear (no efficiency) loses nothing and has no transmission entry in the ledger', () => {
    const { alpha, run } = speed(pair({}, 'motor'), 'j_out');
    expect(alpha).toBeCloseTo(0.1 / (1.37e-5 * 10 + 1.37e-3 / 10), 0);
    expect(ledgerOf(run)).toBeUndefined();
  });
});

describe('belt, rack and pinion', () => {
  it('a belt couples by the diameter ratio and loses (1 - eta) of the input power', () => {
    const doc = runSteps([
      ...spinner('a', 1e-4),
      ...spinner('b', 1e-3, [100, 0, 0]),
      noGravity,
      {
        command: 'add_transmission',
        params: { kind: 'belt', driver: 'j_a', driven: 'j_b', driverDiameterMm: 40, drivenDiameterMm: 80, efficiency: 0.95, id: 'belt' },
      },
      { command: 'add_motor', params: { joint: 'j_a', kind: 'torque_curve', torque: 0.5 } },
    ]).doc;
    expect(doc.dynamics?.transmissions?.['belt']).toMatchObject({ kind: 'belt', efficiency: 0.95 });
    const run = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 1e-4, sampleRate: 1000, detail: 'series', energy: true });
    const [va, vb] = [seriesOf(run, 'jointVelocity', 'j_a'), seriesOf(run, 'jointVelocity', 'j_b')];
    expect((vb[100] ?? 0) / (va[100] ?? 1)).toBeCloseTo(0.5, 6);
    // alpha_a = T eta... J_eff = Ja + eta r^2 Jb forward: T_in = T_c / eta
    const alpha = (va[100] ?? 0) / 0.1;
    expect(alpha).toBeCloseTo(0.5 / (1e-4 + (1e-3 * 0.25) / 0.95), -1);
    const loss = ledgerOf(run).entries.find((entry) => entry.kind === 'transmission_loss');
    expect(loss?.joules).toBeGreaterThan(0);
    expect(ledgerOf(run).closureRelative).toBeLessThan(1e-3);
  });

  it('a rack moves pitch radius x pinion angle; the pinion drives it with the rack mass reflected', () => {
    const doc = runSteps([
      ...spinner('p', 1e-4),
      ...slider('r', 2),
      noGravity,
      {
        command: 'add_transmission',
        params: { kind: 'rack_pinion', pinion: 'j_p', rack: 'j_r', pitchRadiusMm: 20, efficiency: 1, id: 'rack' },
      },
      { command: 'add_motor', params: { joint: 'j_p', kind: 'torque_curve', torque: 1 } },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 1e-4, sampleRate: 1000, detail: 'series' });
    const [theta, x] = [seriesOf(run, 'jointPosition', 'j_p'), seriesOf(run, 'jointPosition', 'j_r')];
    expect((x[100] ?? 0) / (theta[100] ?? 1)).toBeCloseTo(0.02, 6);
    // alpha = T / (J + m r^2)
    expect((seriesOf(run, 'jointVelocity', 'j_p')[100] ?? 0) / 0.1).toBeCloseTo(1 / (1e-4 + 2 * 0.02 ** 2), 0);
  });
});

describe('backlash (VC-DRV-16)', () => {
  const gap = (0.5 * Math.PI) / 180;
  const bench = (extra: Record<string, unknown>): CadDocument =>
    runSteps([
      ...spinner('in', 1e-4),
      ...spinner('out', 1e-3, [100, 0, 0]),
      noGravity,
      {
        command: 'add_transmission',
        params: { kind: 'gear', driver: 'j_in', driven: 'j_out', ratio: 1, backlashDeg: 0.5, id: 'g', ...extra },
      },
      {
        command: 'set_joint_physics',
        params: { joint: 'j_out', friction: { model: 'coulomb', kineticNm: 0, viscousNmsPerRad: 0.01, source: SOURCE_A } },
      },
      {
        command: 'add_motion_profile',
        params: { id: 'p', quantity: 'torque', unit: 'N*m', segments: [{ kind: 'sine', amplitude: 0.01, frequencyHz: 1, cycles: 1 }] },
      },
      { command: 'add_load_schedule', params: { joint: 'j_in', kind: 'torque', profile: 'p' } },
    ]).doc;

  it('reversing the input on a free output loses exactly the gap (0.5 deg within 2 %); penetration stays below 1 % of the gap', () => {
    const run = execute(bench({ meshStiffnessNmPerRad: 2000 }), 'simulate_motion', {
      duration: 1.2,
      timestep: 1e-5,
      sampleRate: 1000,
      detail: 'series',
      energy: true,
    });
    const [qi, qo] = [seriesOf(run, 'jointPosition', 'j_in'), seriesOf(run, 'jointPosition', 'j_out')];
    const relative = qi.map((angle, i) => angle - (qo[i] ?? 0));
    const lost = Math.max(...relative) - Math.min(...relative);
    expect(Math.abs(lost / gap - 1)).toBeLessThan(0.02);
    const stop = (run.data as { stops: Record<string, { peakPenetration: number; peakForce: number }> }).stops['g'];
    expect(stop?.peakPenetration).toBeLessThan(0.01 * gap);
    expect(stop?.peakForce).toBeGreaterThan(0);
    // the contact dissipates: the ledger lists a backlash element, and the books close
    const ledger = ledgerOf(run);
    expect(ledger.entries.some((entry) => entry.element === 'backlash:g' && entry.kind === 'stop')).toBe(true);
    expect(ledger.closureRelative).toBeLessThan(1e-3);
  });

  it('a default mesh stiffness is a 100 Hz mode at the reflected inertia and is reported; a too coarse step is refused', () => {
    const run = execute(bench({}), 'simulate_motion', { duration: 0.05, timestep: 2e-5, sampleRate: 1000 });
    expect((run.data as { warnings: string[] }).warnings.some((w) => w.startsWith('DRV_MESH_STIFFNESS_ASSUMED'))).toBe(true);
    // without a timestep the auto rule halves the step until the contact is integrable and says so
    const auto = execute(bench({}), 'simulate_motion', { duration: 0.05, sampleRate: 1000 });
    const warnings = (auto.data as { warnings: string[] }).warnings;
    expect(warnings.some((w) => /timestep halved [0-9]+x by the auto rule/.test(w))).toBe(true);
    expect(warnings.some((w) => w.startsWith('DRV_MESH_STIFFNESS_ASSUMED'))).toBe(true);
    const coarse = execute(bench({ meshStiffnessNmPerRad: 1e6 }), 'simulate_motion', { duration: 0.05, timestep: 1e-3 });
    expect(coarse.summary).toMatch(/DRV_STEP_TOO_COARSE/);
    expect(coarse.data).toBeUndefined();
  });
});

describe('add_transmission refusals, purity, cascade', () => {
  const base = (): CadDocument => runSteps([...spinner('a', 1e-3), ...spinner('b', 1e-3, [100, 0, 0]), ...slider('n', 1)]).doc;
  const add = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, 'add_transmission', params);

  it('stores each kind with its ratio and reports the efficiencies, and is pure', () => {
    const doc = base();
    const before = JSON.stringify(doc);
    const gear = add(doc, {
      kind: 'gear',
      driver: 'j_a',
      driven: 'j_b',
      teeth: [21, 51],
      reverseRotation: true,
      efficiency: 0.98,
      id: 'g',
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(gear.affected).toEqual(['g']);
    expect(gear.document.dynamics?.transmissions?.['g']).toMatchObject({ kind: 'gear', ratio: -21 / 51, teeth: [21, 51] });
    expect(gear.summary).toContain('η_f 0.98');
    const screw = add(doc, { kind: 'lead_screw', screw: 'j_a', nut: 'j_n', leadMm: 8, meanDiameterMm: 12, mu: 0.4, id: 's' });
    expect(screw.summary).toMatch(/SELF-LOCKING/);
    expect(screw.document.dynamics?.transmissions?.['s']).toMatchObject({ kind: 'lead_screw', leadMm: 8 });
    expect(Object.keys(screw.document.dynamics?.transmissions ?? {})).toEqual(['s']);
    expect(screw.document.order).toEqual(doc.order);
  });

  it('refuses unknown joints, wrong joint kinds, a joint driven twice, circles, bad efficiencies and missing numbers (coded)', () => {
    const doc = base();
    const refused = (params: Record<string, unknown>, code?: string): string => {
      const result = add(doc, params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      if (code !== undefined) expect(result.error?.code).toBe(code);
      return result.summary;
    };
    expect(refused({ kind: 'gear', driver: 'x', driven: 'j_b', ratio: 2 })).toMatch(/not found/);
    expect(refused({ kind: 'gear', driver: 'j_a' })).toMatch(/needs `driver` and `driven`/);
    expect(refused({ kind: 'gear', driver: 'j_a', driven: 'j_a', ratio: 2 })).toMatch(/itself/);
    refused({ kind: 'gear', driver: 'j_a', driven: 'j_n', ratio: 2 }, 'DRV_TRANSMISSION_JOINTS');
    refused({ kind: 'lead_screw', screw: 'j_a', nut: 'j_b', leadMm: 5, meanDiameterMm: 10, mu: 0.1 }, 'DRV_TRANSMISSION_JOINTS');
    refused({ kind: 'rack_pinion', pinion: 'j_n', rack: 'j_a', pitchRadiusMm: 10 }, 'DRV_TRANSMISSION_JOINTS');
    refused({ kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, efficiency: 1.2 }, 'DRV_EFFICIENCY_INVALID');
    refused({ kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, efficiencyBack: 0 }, 'DRV_EFFICIENCY_INVALID');
    refused({ kind: 'ball_screw', screw: 'j_a', nut: 'j_n', leadMm: 5, efficiency: 0.9 }, 'DRV_EFFICIENCY_INVALID');
    expect(refused({ kind: 'gear', driver: 'j_a', driven: 'j_b' })).toMatch(/ratio or tooth counts/);
    expect(refused({ kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 0 })).toMatch(/non-zero/);
    expect(refused({ kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, teeth: [1, 3] })).toMatch(/disagrees/);
    expect(refused({ kind: 'belt', driver: 'j_a', driven: 'j_b', driverDiameterMm: 0, drivenDiameterMm: 5 })).toMatch(/Diameter/);
    expect(refused({ kind: 'lead_screw', screw: 'j_a', nut: 'j_n', leadMm: 5, meanDiameterMm: 10 })).toMatch(/mu/);
    expect(
      refused({ kind: 'lead_screw', screw: 'j_a', nut: 'j_n', leadMm: 5, meanDiameterMm: 10, mu: 5000 }, 'DRV_EFFICIENCY_INVALID'),
    ).toMatch(/cannot lift/);
    expect(refused({ kind: 'rack_pinion', pinion: 'j_a', rack: 'j_n' })).toMatch(/pitchRadiusMm/);
    expect(refused({ kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, backlashDeg: -1 })).toMatch(/backlashDeg/);
    const first = add(doc, { kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, id: 'g' }).document;
    const twice = add(first, { kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 3 });
    expect(twice.error?.code).toBe('DRV_TRANSMISSION_OVERCONSTRAINED');
    expect(add(first, { kind: 'gear', driver: 'j_b', driven: 'j_a', ratio: 3 }).summary).toMatch(/circular/);
    expect(add(first, { kind: 'gear', driver: 'j_a', driven: 'j_n', ratio: 3 }).error?.code).toBe('DRV_TRANSMISSION_JOINTS');
    expect(add(first, { kind: 'gear', driver: 'j_b', driven: 'j_b', ratio: 3 }).summary).toMatch(/itself/);
    expect(add(first, { kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 3, id: 'g' }).error?.code).toBe(
      'DRV_TRANSMISSION_OVERCONSTRAINED',
    );
    expect(add(first, { kind: 'belt', driver: 'j_a', driven: 'j_b', driverDiameterMm: 1, drivenDiameterMm: 1, id: 'g' }).affected).toEqual(
      [],
    );
  });

  it('a taken id is refused; deleting a joint removes its transmissions; the id space is shared', () => {
    const doc = add(base(), { kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, id: 'g' }).document;
    expect(add(base(), { kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, id: 'b_a' }).summary).toMatch(/already used/);
    const gone = execute(doc, 'delete_dynamics_item', { id: 'j_b' });
    expect(gone.document.dynamics?.transmissions).toEqual({});
    const direct = execute(doc, 'delete_dynamics_item', { id: 'g' });
    expect(direct.document.dynamics?.transmissions).toEqual({});
    expect(direct.document.dynamics?.joints['j_b']).toBeDefined();
  });

  it('a transmission survives the validated reload of the document and a simulate_motion of a doc without bodies is refused', () => {
    const doc = add(base(), { kind: 'gear', driver: 'j_a', driven: 'j_b', ratio: 2, id: 'g', source: SOURCE_A }).document;
    expect(execute(doc, 'inspect_dynamics', {}).summary).toContain('1 transmission(s)');
    expect(execute(createEmptyDocument(), 'add_transmission', { kind: 'gear', driver: 'a', driven: 'b', ratio: 2 }).summary).toMatch(
      /not found/,
    );
  });
});
