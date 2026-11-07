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
