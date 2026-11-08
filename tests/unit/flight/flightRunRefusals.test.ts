/**
 * run_flight refusals that only a hand-edited (or stale) document or a failing engine reaches: the command layer refuses them by code instead of
 * throwing (13 FLT M2). Documents are edited directly here on purpose: no command can build them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine, SimulationDivergedError, type PhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import type { FlightMetrics } from '@dynamics/flight/flightMetrics';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { expectNoOp } from '../../helpers/expectNoOp';
import { flightData, quadDrone, rotorParams, step } from './flightFixture';

let mujoco: PhysicsEngine;
beforeAll(async () => {
  mujoco = await createMujocoPhysics();
  setPhysicsEngine(mujoco);
});
afterAll(() => setPhysicsEngine(null));

const flying = (): CadDocument => {
  const doc = step(quadDrone(), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc;
  return step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', durationS: 0.2, id: 's' }).doc;
};

/** `doc` with `patch` applied to its flight slice (bypassing the commands). */
function edited(doc: CadDocument, patch: (flight: NonNullable<CadDocument['flight']>) => NonNullable<CadDocument['flight']>): CadDocument {
  const flight = doc.flight;
  if (flight === undefined) throw new Error('no flight slice');
  return { ...doc, flight: patch(flight) };
}

const codeOf = (doc: CadDocument): string | undefined => execute(doc, 'run_flight', { scenario: 's' }).error?.code;

describe('run_flight refusals of a stale document or a failing engine', () => {
  it('refuses a scenario whose controller is gone and a controller naming a missing rotor', () => {
    const noController = edited(flying(), (flight) => ({ ...flight, controllers: {} }));
    expectNoOp(execute(noController, 'run_flight', { scenario: 's' }), noController, "names a missing controller 'fc'");
    expect(codeOf(noController)).toBe('FLT_MODEL_INVALID');
    const ghostRotor = edited(flying(), (flight) => ({
      ...flight,
      controllers: {
        fc: { ...(flight.controllers?.['fc'] as NonNullable<typeof flight.controllers>[string]), rotorIds: ['r1', 'r2', 'r3', 'ghost'] },
      },
    }));
    expect(execute(ghostRotor, 'run_flight', { scenario: 's' }).summary).toContain("controller 'fc' names a missing rotor");
  });

  it('refuses FLT_MIXER_RANK at run time for a rotor that lost its static thrust and for a mixer that no longer commands 4 axes', () => {
    const dead = edited(flying(), (flight) => ({
      ...flight,
      rotors: {
        ...flight.rotors,
        r1: {
          ...(flight.rotors['r1'] as NonNullable<(typeof flight.rotors)[string]>),
          coefficients: { kind: 'static', thrustCoefficient: 0, powerCoefficient: 0, source: 'edited' },
        },
      },
    }));
    expect(codeOf(dead)).toBe('FLT_MIXER_RANK');
    const flat = edited(flying(), (flight) => ({
      ...flight,
      controllers: {
        fc: {
          ...(flight.controllers?.['fc'] as NonNullable<typeof flight.controllers>[string]),
          mixer: Array.from({ length: 4 }, () => [0.25, 0, 0, 0] as const),
        },
      },
    }));
    expect(codeOf(flat)).toBe('FLT_MIXER_RANK');
  });

  it('refuses a rotor on a body fixed to the ground (FLT_MODEL_INVALID) and an engine that throws (FLT_MODEL_INVALID / FLT_DIVERGED)', () => {
    let doc = flying();
    const box = step(doc, 'add_box', { size: [10, 10, 10], position: [500, 0, 0] });
    doc = step(box.doc, 'add_rigid_body', { entityIds: [box.id], id: 'stand', massKg: 1 }).doc;
    doc = step(doc, 'add_rotor', rotorParams({ id: 'fan', body: 'stand', thrustCoefficient: 0.1, powerCoefficient: 0.05 })).doc;
    const fixed = {
      ...doc,
      dynamics: { ...doc.dynamics!, bodies: { ...doc.dynamics!.bodies, stand: { ...doc.dynamics!.bodies['stand']!, fixed: true } } },
    };
    expect(execute(fixed, 'run_flight', { scenario: 's' }).summary).toContain("acts on 'stand', which is fixed to the ground");
    const failing = (error: Error): PhysicsEngine => ({
      name: 'failing',
      simulate: () => {
        throw error;
      },
    });
    setPhysicsEngine(failing(new Error('bad model')));
    try {
      const rejected = execute(flying(), 'run_flight', { scenario: 's' });
      expect(rejected.error?.code).toBe('FLT_MODEL_INVALID');
      expect(rejected.summary).toContain('the physics engine rejected the model: bad model');
      // the class decides, not the text: a message that merely says "diverged" is a rejected model
      setPhysicsEngine(failing(new Error('the solver diverged while parsing')));
      expect(execute(flying(), 'run_flight', { scenario: 's' }).error?.code).toBe('FLT_MODEL_INVALID');
      setPhysicsEngine(failing(new SimulationDivergedError(0.1234)));
      const diverged = execute(flying(), 'run_flight', { scenario: 's' });
      expect(diverged.error?.code).toBe('FLT_DIVERGED');
      expect(diverged.summary).toContain('t = 0.1234 s');
    } finally {
      setPhysicsEngine(mujoco);
    }
  });

  it('refuses a vehicle body that carries a jointed body (FLT_VEHICLE_MULTIBODY) until FLT-M4', () => {
    let doc = flying();
    const box = step(doc, 'add_box', { size: [10, 10, 10], position: [0, 0, 80] });
    doc = step(box.doc, 'add_rigid_body', { entityIds: [box.id], id: 'wing', massKg: 0.1 }).doc;
    doc = step(doc, 'add_body_joint', {
      kind: 'revolute',
      parent: 'frame',
      child: 'wing',
      anchor: [0, 0, 80],
      axis: [1, 0, 0],
      id: 'pivot',
    }).doc;
    const refused = execute(doc, 'run_flight', { scenario: 's' });
    expectNoOp(refused, doc, "body 'frame' carries 1 jointed body ('wing')");
    expect(refused.error).toMatchObject({ code: 'FLT_VEHICLE_MULTIBODY', ids: ['frame', 'wing'] });
    expect(execute(doc, 'flight_report', { scenario: 's' }).error?.code).toBe('FLT_VEHICLE_MULTIBODY');
  });

  it('refuses at run time a layout that became nearly singular (FLT_MIXER_ILL_CONDITIONED)', () => {
    const thin = edited(flying(), (flight) => ({
      ...flight,
      rotors: Object.fromEntries(
        Object.entries(flight.rotors).map(([id, rotor]) => [
          id,
          { ...rotor, hub: [rotor.hub[0], Math.sign(rotor.hub[1]) * 0.01, 0] as const },
        ]),
      ),
    }));
    expect(codeOf(thin)).toBe('FLT_MIXER_ILL_CONDITIONED');
  });

  it('flies a rotor on a second free body at its own rpm under the wind (it is in the block, not controlled)', () => {
    let doc = flying();
    const box = step(doc, 'add_box', { size: [10, 10, 10], position: [500, 0, 0] });
    doc = step(box.doc, 'add_rigid_body', { entityIds: [box.id], id: 'pod', massKg: 1 }).doc;
    doc = step(doc, 'add_rotor', rotorParams({ id: 'fan', body: 'pod', rpm: 3000, thrustCoefficient: 0.1, powerCoefficient: 0.05 })).doc;
    doc = step(doc, 'define_flight_scenario', {
      body: 'frame',
      controller: 'fc',
      durationS: 0.2,
      id: 'windy',
      wind: { steady: [0, 0, -2] },
    }).doc;
    const metrics = flightData(doc, 'run_flight', { scenario: 'windy' }) as unknown as FlightMetrics;
    expect(metrics.rotors['fan']).toMatchObject({ controlled: false, finalRpm: 3000 });
    // 2 m/s of air coming down through the disc: J = 2 / (50 · 0.254) = 0.157, outside the static pair's range
    expect(metrics.rotors['fan']?.finalAdvanceRatio).toBeGreaterThan(0.1);
    expect(metrics.warnings.some((warning) => warning.startsWith("FLT_OUTSIDE_VALIDATED_RANGE: rotor 'fan'"))).toBe(true);
    expect(metrics.rotors['fan']?.figureOfMerit).toBeNull();
  });
});
