/**
 * Flight slice of the dynamics plugin (`CadDocument.flight`, aerospace 13 FLT): body-fixed rotors and body drag acting on the rigid bodies of
 * `doc.dynamics`. Lengths of points are document units at the modelled pose; every physical quantity is SI.
 */

import type { CadDocument } from '@core/model/types';
import { createDynamicsModel, dynamicsIdTaken } from '@core/model/dynamics';
import type { Vec3 } from '@core/model/vectors';
import type { FlightController, FlightScenario } from './controlModel';
import type { AeroSurface } from './aeroModel';
import type { FlightBattery, FlightPowertrain } from './powerModel';

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
 * @invariant bodyId is a non-fixed rigid body (a body referenced by a rotor or a body drag is never fixed: a future set_body_fixed must cascade
 *            or refuse); axis non-zero; rpm >= 0; diameter, airDensity > 0; spinInertiaKgM2 >= 0
 * @invariant id unique across doc.dynamics records and rotors (idTakenInDynamicsOrFlight)
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
  /** Absent until the first add_flight_controller (13 FLT M2). */
  readonly controllers?: Readonly<Record<string, FlightController>>;
  /** Absent until the first define_flight_scenario (13 FLT M2). */
  readonly scenarios?: Readonly<Record<string, FlightScenario>>;
  /** Absent until the first add_battery (13 FLT M3). */
  readonly batteries?: Readonly<Record<string, FlightBattery>>;
  /** Absent until the first add_flight_powertrain (13 FLT M3). */
  readonly powertrains?: Readonly<Record<string, FlightPowertrain>>;
  /** Absent until the first generate_aero_table (13 FLT M4). */
  readonly aeroSurfaces?: Readonly<Record<string, AeroSurface>>;
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

/** `scenario` without the pivot commands that name a surface not in `surfaces`. */
function withoutPivots(scenario: FlightScenario, surfaces: Readonly<Record<string, unknown>>): FlightScenario {
  if (scenario.setpoints.every((setpoint) => Object.keys(setpoint.pivotDeg ?? {}).every((id) => Object.hasOwn(surfaces, id))))
    return scenario;
  return {
    ...scenario,
    setpoints: scenario.setpoints.map(({ pivotDeg, ...rest }) => {
      const kept = Object.entries(pivotDeg ?? {}).filter(([id]) => Object.hasOwn(surfaces, id));
      return kept.length === 0 ? rest : { ...rest, pivotDeg: Object.fromEntries(kept) };
    }),
  };
}

/**
 * `flight` without the records `delete_dynamics_item` removes with `id`: the rotor / controller / scenario of that id, every rotor / drag of a
 * body that is no longer in `bodies`, every controller that lost its body or one of its rotors, every scenario that lost its body or its
 * controller, the battery of that id with the powertrain that used it, every powertrain that lost its battery or one of its rotors, the aero
 * surface of that id or whose body is gone, and the pivot commands of a scenario that name a removed surface; null when nothing goes.
 */
export function flightWithout(flight: FlightModel, id: string, bodies: Readonly<Record<string, unknown>>): FlightModel | null {
  const gone = (bodyId: string): boolean => !Object.hasOwn(bodies, bodyId);
  const rotors = Object.fromEntries(Object.entries(flight.rotors).filter(([key, rotor]) => key !== id && !gone(rotor.bodyId)));
  const bodyDrag = Object.fromEntries(Object.entries(flight.bodyDrag).filter(([key]) => !gone(key)));
  const controllers = Object.fromEntries(
    Object.entries(flight.controllers ?? {}).filter(
      ([key, controller]) =>
        key !== id && !gone(controller.bodyId) && controller.rotorIds.every((rotorId) => Object.hasOwn(rotors, rotorId)),
    ),
  );
  const aeroSurfaces = Object.fromEntries(
    Object.entries(flight.aeroSurfaces ?? {}).filter(([key, surface]) => key !== id && !gone(surface.bodyId)),
  );
  const scenarios = Object.fromEntries(
    Object.entries(flight.scenarios ?? {})
      .filter(
        ([key, scenario]) =>
          key !== id && !gone(scenario.bodyId) && (scenario.controllerId === null || Object.hasOwn(controllers, scenario.controllerId)),
      )
      .map(([key, scenario]) => [key, withoutPivots(scenario, aeroSurfaces)]),
  );
  const batteries = Object.fromEntries(Object.entries(flight.batteries ?? {}).filter(([key]) => key !== id));
  const powertrains = Object.fromEntries(
    Object.entries(flight.powertrains ?? {}).filter(
      ([key, train]) =>
        key !== id && Object.hasOwn(batteries, train.batteryId) && train.rotorIds.every((rotorId) => Object.hasOwn(rotors, rotorId)),
    ),
  );
  const next: FlightModel = {
    rotors,
    bodyDrag,
    ...(flight.controllers === undefined ? {} : { controllers }),
    ...(flight.scenarios === undefined ? {} : { scenarios }),
    ...(flight.batteries === undefined ? {} : { batteries }),
    ...(flight.powertrains === undefined ? {} : { powertrains }),
    ...(flight.aeroSurfaces === undefined ? {} : { aeroSurfaces }),
  };
  return flightRecordCount(next) === flightRecordCount(flight) ? null : next;
}

/** Number of records in a flight slice. */
export const flightRecordCount = (flight: FlightModel): number =>
  Object.keys(flight.rotors).length +
  Object.keys(flight.bodyDrag).length +
  Object.keys(flight.controllers ?? {}).length +
  Object.keys(flight.scenarios ?? {}).length +
  Object.keys(flight.batteries ?? {}).length +
  Object.keys(flight.powertrains ?? {}).length +
  Object.keys(flight.aeroSurfaces ?? {}).length;

/** True when `id` names a rotor, controller, scenario, battery or powertrain of `flight`. */
export function flightIdTaken(flight: FlightModel, id: string): boolean {
  return (
    Object.hasOwn(flight.rotors, id) ||
    Object.hasOwn(flight.controllers ?? {}, id) ||
    Object.hasOwn(flight.scenarios ?? {}, id) ||
    Object.hasOwn(flight.batteries ?? {}, id) ||
    Object.hasOwn(flight.powertrains ?? {}, id) ||
    Object.hasOwn(flight.aeroSurfaces ?? {}, id)
  );
}

/**
 * True when `id` is taken in the shared id space of the dynamics plugin: any `doc.dynamics` record or a rotor, controller or scenario of
 * `doc.flight`. Every plugin command that creates a dynamics record checks it (add_motion_profile, in core, cannot: delete_dynamics_item
 * refuses an id that names both).
 */
export function idTakenInDynamicsOrFlight(doc: CadDocument, id: string): boolean {
  return dynamicsIdTaken(doc.dynamics ?? createDynamicsModel(), id) || (doc.flight !== undefined && flightIdTaken(doc.flight, id));
}
