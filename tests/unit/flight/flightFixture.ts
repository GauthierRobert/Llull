/** Shared builders of the 13 FLT tests: a box airframe as a free rigid body with given mass and principal inertia (document units mm). */
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const G = 9.80665;

export function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.affected.length === 0) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** A 100 mm box centred at the origin as body `frame` (free, `massKg`, principal inertia `[Ixx, Iyy, Izz]` kg·m²), gravity `gravity`. */
export function airframe(
  massKg: number,
  inertia: readonly [number, number, number],
  gravity: readonly [number, number, number],
): CadDocument {
  const box = step(createEmptyDocument(), 'add_box', { size: [100, 100, 100], position: [0, 0, 0] });
  const body = step(box.doc, 'add_rigid_body', {
    entityIds: [box.id],
    id: 'frame',
    massKg,
    inertiaKgM2: [inertia[0], inertia[1], inertia[2], 0, 0, 0],
  });
  return execute(body.doc, 'set_gravity', { gravity }).document;
}

/** A static coefficient rotor on `frame` (hub at the centre of mass unless given). */
export function rotorParams(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    body: 'frame',
    hub: [0, 0, 0],
    axis: [0, 0, 1],
    spin: 'ccw',
    rpm: 6000,
    diameter: 0.254,
    thrustCoefficient: 0,
    powerCoefficient: 0,
    source: 'test input',
    ...overrides,
  };
}

/** simulate_motion data of a run (throws with the summary when it did not run). */
export function simulate(doc: CadDocument, params: Record<string, unknown>): Record<string, unknown> & { summary: string } {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return { ...(result.data as Record<string, unknown>), summary: result.summary };
}

/** UIUC APC SF 10x4.7 static row at 4029 rpm (validation [S1]): the reference drone's rotor. */
const UIUC_4029 = { thrustCoefficient: 0.1158, powerCoefficient: 0.0466, source: 'UIUC apcsf_10x4.7_static row 4029 rpm (grade A)' };

/**
 * The reference "wing quad lite" as a quad X (13 FLT validation U1): body `frame` of `massKg` (default 1.115 kg), four 10-inch rotors at
 * (±180, ±180) mm with alternating spins (r1 front-right ccw, r2 rear-left ccw, r3 front-left cw, r4 rear-right cw), gravity -9.80665 Z.
 */
export function quadDrone(massKg = 1.115): CadDocument {
  let doc = airframe(massKg, [0.012, 0.012, 0.022], [0, 0, -G]);
  const hubs: [string, number, number, 'cw' | 'ccw'][] = [
    ['r1', 180, -180, 'ccw'],
    ['r2', -180, 180, 'ccw'],
    ['r3', 180, 180, 'cw'],
    ['r4', -180, -180, 'cw'],
  ];
  for (const [id, x, y, spin] of hubs)
    doc = step(doc, 'add_rotor', rotorParams({ id, hub: [x, y, 0], spin, rpm: 0, ...UIUC_4029, spinInertiaKgM2: 2e-5 })).doc;
  return doc;
}

/** run_flight / flight_report data (throws with the summary when refused). */
export function flightData(
  doc: CadDocument,
  command: 'run_flight' | 'flight_report',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const result = execute(doc, command, params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Record<string, unknown>;
}
