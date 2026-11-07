/**
 * Flight slice of the dynamics plugin (`CadDocument.flight`, aerospace 13 FLT): body-fixed rotors and body drag acting on the rigid bodies of
 * `doc.dynamics`. Lengths of points are document units at the modelled pose; every physical quantity is SI.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';

/** [advance ratio J, C_T, C_P] with strictly increasing J. */
type RotorTablePoint = readonly [advanceRatio: number, thrustCoefficient: number, powerCoefficient: number];

/**
 * Where a rotor's coefficients come from: one static pair (valid at J = 0 only), or a measured C_T(J), C_P(J) table (PCHIP, held at its ends).
 * @invariant source non-empty; coefficients >= 0; table: >= 2 points, J strictly increasing
 */
export type RotorCoefficients =
  | { readonly kind: 'static'; readonly thrustCoefficient: number; readonly powerCoefficient: number; readonly source: string }
  | { readonly kind: 'table'; readonly points: readonly RotorTablePoint[]; readonly source: string; readonly grade: 'A' | 'B' | 'C' };

/**
 * A rotor fixed to a rigid body (TR-FLT-02): thrust T = C_T·ρ·n²·D⁴ along the body-fixed `axis` at `hub`, reaction torque Q = C_P·ρ·n²·D⁵/(2π)
 * about -spin·axis, gyroscopic torque -ω × H of its spinning parts (H = spinInertiaKgM2 · Ω · spin · axis), J = V_axial / (n D) from the body
 * state. `spin` 'ccw' = the rotor turns counter-clockwise seen from the side the thrust points to (angular velocity along +axis).
 * @invariant bodyId is a non-fixed rigid body; axis non-zero; rpm >= 0; diameter, airDensity > 0; spinInertiaKgM2 >= 0
 */
export interface Rotor {
  readonly id: string;
  readonly bodyId: string;
  /** Hub point, world, document units, at the modelled pose (it rides on the body). */
  readonly hub: Vec3;
  /** Thrust direction at the modelled pose (unit), fixed in the body. */
  readonly axis: Vec3;
  readonly spin: 'cw' | 'ccw';
  /** Commanded rotor speed, rev/min (constant over the run). */
  readonly rpm: number;
  /** m. */
  readonly diameter: number;
  readonly coefficients: RotorCoefficients;
  /** kg/m³. */
  readonly airDensity: number;
  /** kg·m² of the parts spinning with the rotor (blades, hub, motor bell) about its axis; 0 = no gyroscopic torque. */
  readonly spinInertiaKgM2: number;
}

/**
 * Quadratic drag of a body (TR-FLT-03, drag part): F_i = -½·ρ·CdA_i·|v|·v_i in the body axes, v the velocity of the centre of mass relative to
 * still air, applied at the centre of mass.
 * @invariant bodyId is a non-fixed rigid body (the record key); every cdaM2 component >= 0 and one > 0; airDensity > 0
 */
export interface BodyDrag {
  readonly bodyId: string;
  /** Drag area C_d·A per body axis (the world axes at the modelled pose), m². */
  readonly cdaM2: Vec3;
  /** kg/m³. */
  readonly airDensity: number;
}

export interface FlightModel {
  readonly rotors: Readonly<Record<string, Rotor>>;
  /** Keyed by body id. */
  readonly bodyDrag: Readonly<Record<string, BodyDrag>>;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first add_rotor / set_body_drag (plugin `dynamics`, 13 FLT). */
    flight?: FlightModel;
  }
}

/** ISA sea-level air density, kg/m³. */
export const ISA_SEA_LEVEL_DENSITY = 1.225;

/** The document's flight slice (empty when absent). */
export function flightOf(doc: CadDocument): FlightModel {
  return doc.flight ?? { rotors: {}, bodyDrag: {} };
}

/**
 * `flight` without the records `delete_dynamics_item` removes with `id`: the rotor of that id, and every rotor / drag of a body that is no
 * longer in `bodies`; null when nothing goes.
 */
export function flightWithout(flight: FlightModel, id: string, bodies: Readonly<Record<string, unknown>>): FlightModel | null {
  const gone = (bodyId: string): boolean => !Object.hasOwn(bodies, bodyId);
  const rotors = Object.fromEntries(Object.entries(flight.rotors).filter(([key, rotor]) => key !== id && !gone(rotor.bodyId)));
  const bodyDrag = Object.fromEntries(Object.entries(flight.bodyDrag).filter(([key]) => !gone(key)));
  const removed =
    Object.keys(flight.rotors).length - Object.keys(rotors).length + Object.keys(flight.bodyDrag).length - Object.keys(bodyDrag).length;
  return removed === 0 ? null : { rotors, bodyDrag };
}

/** Number of records in a flight slice. */
export const flightRecordCount = (flight: FlightModel | undefined): number =>
  flight === undefined ? 0 : Object.keys(flight.rotors).length + Object.keys(flight.bodyDrag).length;
