/**
 * 14 FLL-M2 from a real flight run (MuJoCo): export_flight_loads reads run_flight's series through the registry, rotor thrusts become the mount
 * forces, the relief balance closes to the finite-difference accuracy of the series, and a changed design makes the loads FLL_RUN_STALE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { reliefAssessment } from '@cae/flightLoads/rigidBalance';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { G, airframe, rotorParams, step } from '../flight/flightFixture';
import { mustRun } from './deckFixtures';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae' };
const HUBS: readonly [string, number, number][] = [
  ['r1', 180, -180],
  ['r2', -180, 180],
  ['r3', 180, 180],
  ['r4', -180, -180],
];

const ICUBE = (1.115 * 0.1 * 0.1) / 6;
/** UIUC APC SF 10x4.7 static row at 4029 rpm (the flight validation rotor). */
const ROTOR = { thrustCoefficient: 0.1158, powerCoefficient: 0.0466, source: 'UIUC apcsf_10x4.7_static row 4029 rpm (grade A)' };

/** The quad X of the flight validation with the inertia of its 100 mm cube frame, so the FE body and the flight model are the same rigid body. */
function cubeQuad(): CadDocument {
  let doc = airframe(1.115, [ICUBE, ICUBE, ICUBE], [0, 0, -G]);
  const spins: Record<string, 'cw' | 'ccw'> = { r1: 'ccw', r2: 'ccw', r3: 'cw', r4: 'cw' };
  for (const [id, x, y] of HUBS)
    doc = step(doc, 'add_rotor', rotorParams({ id, hub: [x, y, 0], spin: spins[id], rpm: 0, ...ROTOR, spinInertiaKgM2: 2e-5 })).doc;
  return doc;
}

/** The reference quad (1.115 kg, 100 mm cube frame) with a 1.115 kg/dm^3 material on the frame, a static analysis of it and a climb scenario. */
function droneAnalysis(): { doc: CadDocument; analysisId: string; boxId: string } {
  let doc = step(cubeQuad(), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc;
  doc = step(doc, 'define_flight_scenario', {
    body: 'frame',
    controller: 'fc',
    id: 's',
    durationS: 3,
    setpoints: [{ t: 0 }, { t: 1, position: [0.5, 0, 1] }],
  }).doc;
  const boxId = doc.dynamics?.bodies['frame']?.entityIds[0] ?? '';
  doc = mustRun(doc, 'create_material', { name: 'abs', density: 0.001115, color: '#999999', metalness: 0, roughness: 0.5 });
  doc = mustRun(doc, 'add_material_model', {
    material: 'abs',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 2, unit: 'GPa' }, nu: { value: 0.35, unit: '1' } },
    basis: 'unspecified',
    source: SOURCE,
  });
  doc = mustRun(doc, 'define_constitutive_set', { material: 'abs', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true });
  doc = mustRun(doc, 'assign_material', { materialName: 'abs', entityIds: [boxId] });
  const created = step(doc, 'create_analysis', { name: 'airframe', analysisType: 'static' });
  doc = step(created.doc, 'set_part_idealization', { analysisId: created.id, entityId: boxId }).doc;
  doc = step(doc, 'set_free_body_support', {
    analysisId: created.id,
    entityId: boxId,
    points: [
      [-40, -40, 0],
      [40, -40, 0],
      [-40, 40, 0],
    ],
  }).doc;
  return { doc, analysisId: created.id, boxId };
}

const mounts = (boxId: string): Record<string, unknown>[] =>
  HUBS.map(([rotorId, x, y]) => ({
    name: `${rotorId} mount`,
    rotorId,
    direction: [0, 0, 1],
    target: { entityId: boxId, pointsNear: [[x, y, 0]] },
  }));

interface Instant {
  loadCase: string;
  timeS: number | null;
  pick: string;
  accelMps2: number[];
  thrustN: Record<string, number>;
  loadIds: string[];
}

describe('export_flight_loads from a flight scenario', () => {
  const { doc, analysisId, boxId } = droneAnalysis();
  const exportedAt = (at: unknown, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(doc, 'export_flight_loads', { analysisId, scenario: 's', at, sampleRate: 1000, mounts: mounts(boxId), ...extra });

  it('peak_load: one load case at the largest specific force, thrust / mass the acceleration, rotor thrusts as mount forces', () => {
    const result = exportedAt('peak_load');
    expect(result.rejected, result.summary).not.toBe(true);
    const instants = (result.data as { instants: Instant[] }).instants;
    expect(instants).toHaveLength(1);
    const instant = instants[0] as Instant;
    expect(instant.loadCase).toBe('FLT_s_peak');
    expect(instant.timeS).toBeGreaterThan(0.9);
    // inertial + gravity + 4 force mounts
    const analysis = result.document.analysis?.cases[analysisId];
    expect(analysis?.loadOrder).toHaveLength(6);
    const loads = result.affected.map((id) => analysis?.loads[id]);
    expect(loads.map((load) => load?.kind)).toEqual(['inertial', 'gravity', 'force', 'force', 'force', 'force']);
    // vertical equation of motion: m a_z = sum T - m g (no drag in this scenario): a_z from the series vs the recorded thrusts
    const totalThrust = Object.values(instant.thrustN).reduce((sum, value) => sum + value, 0);
    const forces = loads.slice(2).map((load) => load?.vector?.[2] ?? 0);
    expect(forces.reduce((sum, value) => sum + value, 0)).toBeCloseTo(totalThrust, 6);
    expect(loads[1]?.vector?.[2] ?? 0).toBeLessThan(-9000);
    expect(loads[0]?.flightSource?.scenario).toBe('s');
    expect(loads[0]?.flightSource?.timeS).toBeCloseTo(instant.timeS ?? 0, 9);
    expect(loads[0]?.flightSource?.designHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.summary).toContain('FLT_s_peak');
  });

  it('the rigid-body balance closes: force residual below 1e-4 of the applied with the rotor thrusts as mounts, and the moment; not without mounts', () => {
    const result = exportedAt('peak_load');
    const full = reliefAssessment(result.document, result.document.analysis?.cases[analysisId] ?? ({} as never));
    expect(full?.unassessed).toEqual([]);
    const balance = full?.balances[0];
    expect(balance?.appliedForce).toBeGreaterThan(5);
    expect((balance?.residualForce ?? 1) / (balance?.appliedForce ?? 1)).toBeLessThan(1e-4);
    // the flight model and the FE body are the same rigid body (mass, centre, inertia), so the moment closes too
    expect((balance?.residualMoment ?? 1) / (balance?.appliedMoment ?? 1)).toBeLessThan(1e-4);
    expect(balance?.balanced).toBe(true);
    const clean = execute(result.document, 'check_analysis', { analysisId });
    expect((clean.data as { items: { code: string }[] }).items.map((item) => item.code)).not.toContain('FLL_RELIEF_RESIDUAL');
    const bare = execute(doc, 'export_flight_loads', { analysisId, scenario: 's', at: 'peak_load', sampleRate: 1000 });
    const bareBalance = reliefAssessment(bare.document, bare.document.analysis?.cases[analysisId] ?? ({} as never))?.balances[0];
    expect(bareBalance?.balanced).toBe(false);
    expect((bareBalance?.residualForce ?? 0) / (bareBalance?.appliedForce ?? 1)).toBeGreaterThan(0.5);
    const checked = execute(bare.document, 'check_analysis', { analysisId });
    expect((checked.data as { items: { code: string }[] }).items.map((item) => item.code)).toContain('FLL_RELIEF_RESIDUAL');
  });

  it('a time picks the nearest sample; envelope gives up to three distinct load cases; a time past the end is refused', () => {
    const at = exportedAt(1.5).data as { instants: Instant[] };
    expect(at.instants).toHaveLength(1);
    expect(at.instants[0]?.loadCase).toBe('FLT_s_t1500ms');
    expect(at.instants[0]?.timeS).toBeCloseTo(1.5, 6);
    const envelope = exportedAt('envelope').data as { instants: Instant[] };
    expect(envelope.instants.length).toBeGreaterThanOrEqual(1);
    expect(envelope.instants.length).toBeLessThanOrEqual(3);
    expect(new Set(envelope.instants.map((entry) => entry.timeS)).size).toBe(envelope.instants.length);
    expect(envelope.instants.map((entry) => entry.loadCase).every((name) => name.startsWith('FLT_s_peak_'))).toBe(true);
    const late = exportedAt(99);
    expectNoOp(late, doc);
    expect(late.error?.code).toBe('FLL_INSTANT_UNKNOWN');
  });

  it('the DEFAULT sampling (1 kHz) closes the 1e-4 relief gate with no warning and reports the effective rate', () => {
    const result = execute(doc, 'export_flight_loads', { analysisId, scenario: 's', mounts: mounts(boxId) });
    expect(result.rejected, result.summary).not.toBe(true);
    expect(result.summary).not.toContain('WARNING');
    expect((result.data as { effectiveSampleRateHz: number }).effectiveSampleRateHz).toBeGreaterThan(990);
    const codes = (execute(result.document, 'check_analysis', { analysisId }).data as { items: { code: string }[] }).items.map(
      (item) => item.code,
    );
    expect(codes).not.toContain('FLL_RELIEF_RESIDUAL');
  });

  it('a long run is coarsened by run_flight: the effective rate is reported and the summary warns', () => {
    const long = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 'long', durationS: 12 }).doc;
    const result = execute(long, 'export_flight_loads', { analysisId, scenario: 'long', mounts: mounts(boxId) });
    expect(result.rejected, result.summary).not.toBe(true);
    expect((result.data as { effectiveSampleRateHz: number }).effectiveSampleRateHz).toBeLessThan(900);
    expect(result.summary).toContain('WARNING');
  });

  it('is pure; a mount that names a rotor the run does not have is refused', () => {
    expectPure(doc, () => exportedAt('peak_load'));
    const bad = exportedAt('peak_load', {
      mounts: [{ name: 'ghost', rotorId: 'rX', direction: [0, 0, 1], target: { entityId: boxId, pointsNear: [[0, 0, 0]] } }],
    });
    expectNoOp(bad, doc);
    expect(bad.error?.code).toBe('FLL_MOUNT_INVALID');
  });

  it('FLL_RUN_STALE: changing the flown design after the export flags every load of the run; unrelated changes do not', () => {
    const exported = exportedAt('peak_load').document;
    const stale = (d: CadDocument): string[] =>
      ((execute(d, 'check_analysis', { analysisId }).data as { items: { code: string }[] }).items ?? []).map((item) => item.code);
    expect(stale(exported)).not.toContain('FLL_RUN_STALE');
    const unrelated = step(exported, 'add_box', { size: [5, 5, 5], position: [900, 900, 900] }).doc;
    expect(stale(unrelated)).not.toContain('FLL_RUN_STALE');
    const heavier = mustRun(exported, 'set_gravity', { gravity: [0, 0, -G * 1.5] });
    expect(stale(heavier)).toContain('FLL_RUN_STALE');
    const gained = step(exported, 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc2' }).doc;
    expect(stale(gained)).toContain('FLL_RUN_STALE');
  });

  it('convex_envelope: one balanced load case per hull vertex of the specific force, in time order', () => {
    const result = exportedAt('convex_envelope');
    expect(result.rejected, result.summary).not.toBe(true);
    const instants = (result.data as { instants: Instant[] }).instants;
    expect(instants.length).toBeGreaterThanOrEqual(2);
    expect(instants.map((entry) => entry.loadCase)).toEqual(instants.map((_, k) => `FLT_s_hull_${k + 1}`));
    const times = instants.map((entry) => entry.timeS ?? 0);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // the peak-load instant has the largest specific force, so it is a hull vertex
    const peak = (exportedAt('peak_load').data as { instants: Instant[] }).instants[0]?.timeS;
    expect(times).toContain(peak);
    const relief = reliefAssessment(result.document, result.document.analysis?.cases[analysisId] ?? ({} as never));
    expect(relief?.balances.map((balance) => balance.balanced)).toEqual(instants.map(() => true));
  });

  it('refuses a scenario the flight run refuses (the refusal is carried) and an analysis without a dynamics model', () => {
    const unknown = execute(doc, 'export_flight_loads', { analysisId, scenario: 'ghost' });
    expectNoOp(unknown, doc);
    expect(unknown.error?.code).toBe('FLL_RUN_FAILED');
    expect(unknown.summary).toContain('FLT_SCENARIO_UNKNOWN');
  });
});

describe('rotor reaction torques as mount moments (FLL-M2b)', () => {
  const { doc: base, analysisId, boxId } = droneAnalysis();
  const doc = step(base, 'define_flight_scenario', {
    body: 'frame',
    controller: 'fc',
    id: 'yaw',
    durationS: 1.2,
    setpoints: [{ t: 0 }, { t: 0.2, yawDeg: 40 }],
  }).doc;
  /** Rotor mounts on four points around each hub (their mean is the hub, where the flight model applies the thrust). */
  const torqueMounts = (reactionTorque: boolean): Record<string, unknown>[] =>
    HUBS.map(([rotorId, x, y]) => ({
      name: `${rotorId} mount`,
      rotorId,
      direction: [0, 0, 1],
      reactionTorque,
      target: {
        entityId: boxId,
        pointsNear: [
          [x - 10, y, 0],
          [x + 10, y, 0],
          [x, y - 10, 0],
          [x, y + 10, 0],
        ],
      },
    }));
  const exported = (reactionTorque: boolean): ReturnType<typeof execute> =>
    execute(doc, 'export_flight_loads', {
      analysisId,
      scenario: 'yaw',
      at: 'envelope',
      sampleRate: 1000,
      mounts: torqueMounts(reactionTorque),
    });

  it('adds one moment per rotor about its axis: negative for the ccw rotors, positive for the cw ones (reaction -s Q a)', () => {
    const result = exported(true);
    expect(result.rejected, result.summary).not.toBe(true);
    const analysis = result.document.analysis?.cases[analysisId];
    const torques = result.affected.map((id) => analysis?.loads[id]).filter((load) => load?.name.endsWith('rotor torque'));
    const instants = (result.data as { instants: Instant[] }).instants;
    expect(torques).toHaveLength(4 * instants.length);
    const first = torques.filter((load) => load?.loadCase === instants[0]?.loadCase);
    expect(first.map((load) => load?.name)).toEqual([
      'r1 mount rotor torque',
      'r2 mount rotor torque',
      'r3 mount rotor torque',
      'r4 mount rotor torque',
    ]);
    // r1, r2 ccw; r3, r4 cw; the yaw component dominates (the gyroscopic part is omega x H, about x and y)
    expect(first.map((load) => Math.sign(load?.vector?.[2] ?? 0))).toEqual([-1, -1, 1, 1]);
    // Q of a 10x4.7 at hover, about 0.03 N m = 30 N mm
    expect(Math.abs(first[0]?.vector?.[2] ?? 0)).toBeGreaterThan(5);
    expect(Math.abs(first[0]?.vector?.[2] ?? 0)).toBeLessThan(200);
  });

  it('closes the moment balance of a yaw manoeuvre (peak angular acceleration) that the thrust mounts alone leave open', () => {
    const ratio = (result: ReturnType<typeof execute>): number => {
      const relief = reliefAssessment(result.document, result.document.analysis?.cases[analysisId] ?? ({} as never));
      const peak = relief?.balances.find((balance) => balance.loadCase.endsWith('_peak_a'));
      return (peak?.residualMoment ?? 1) / (peak?.appliedMoment ?? 1);
    };
    const without = ratio(exported(false));
    const withTorque = ratio(exported(true));
    // measured: 9.8e-3 without (FLL_RELIEF_RESIDUAL), 1.5e-7 with the torques (the 1e-4 gate)
    expect(without).toBeGreaterThan(1e-3);
    expect(withTorque).toBeLessThan(1e-5);
  });

  it('convex_envelope of a 3D manoeuvre: a quad without drag has its specific force on the body z axis, so the hull is the thrust range at 2 %; a tighter tolerance keeps more vertices; a tolerance out of (0, 0.5] is rejected', () => {
    const setpoints = [
      { t: 0 },
      ...[1, 2, 3, 4, 5, 6].map((k) => ({ t: 0.25 * k, position: [0.3 * Math.sin(k), 0.3 * Math.cos(1.7 * k), 0.2 * k] })),
    ];
    const wild = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 'wild', durationS: 2, setpoints }).doc;
    const counts = [0.02, 1e-9].map((envelopeTolerance) => {
      const result = execute(wild, 'export_flight_loads', {
        analysisId,
        scenario: 'wild',
        at: 'convex_envelope',
        envelopeTolerance,
        mounts: torqueMounts(true),
      });
      return result.rejected === true ? result.error?.code : (result.data as { instants: Instant[] }).instants.length;
    });
    // measured: 2 vertices at 2 %, 44 at 1e-9 (the 48-case cap, FLL_ENVELOPE_TOO_LARGE, is not reached by this 2 s run)
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBeGreaterThan(10);
    expect(counts[1]).toBeLessThanOrEqual(48);
    for (const envelopeTolerance of [0, 0.6]) {
      const bad = execute(wild, 'export_flight_loads', { analysisId, scenario: 'wild', at: 'convex_envelope', envelopeTolerance });
      expectNoOp(bad, wild);
      expect(bad.summary).toContain('invalid params');
    }
  });

  it('refuses a rotor torque on a target that cannot carry a moment, and without a rotor', () => {
    const point = execute(doc, 'export_flight_loads', {
      analysisId,
      scenario: 'yaw',
      mounts: [
        { name: 'p', rotorId: 'r1', direction: [0, 0, 1], reactionTorque: true, target: { entityId: boxId, pointsNear: [[180, -180, 0]] } },
      ],
    });
    expectNoOp(point, doc);
    expect(point.error?.code).toBe('FLL_MOUNT_INVALID');
    expect(point.summary).toContain('a rotor torque needs a face, an edge or at least three points');
    const fixed = execute(doc, 'export_flight_loads', {
      analysisId,
      scenario: 'yaw',
      mounts: [{ name: 'f', force: [1, 0, 0], reactionTorque: true, target: { entityId: boxId, facesNear: [[0, 0, 50]] } }],
    });
    expect(fixed.error?.code).toBe('FLL_MOUNT_INVALID');
    expect(fixed.summary).toContain('reactionTorque needs a rotorId');
  });
});
