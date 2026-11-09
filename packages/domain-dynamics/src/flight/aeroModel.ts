/**
 * Aerodynamic surface records of the flight slice (13 FLT M4, TR-FLT-03): a coefficient table CL / CD / Cm over the angle of attack and the
 * pivot angle of the surface, generated from the vortex-lattice query plus a stated profile-drag model, acting at a body-fixed point. Plain data;
 * SI except the document-unit points. Flow frame of a surface: x downstream (against the travel direction `forward`), y spanwise
 * (z × x), z up (body Z).
 */

import type { Vec3 } from '@core/model/vectors';

/** Body axis the vehicle travels along (the air comes from the opposite side). */
export type ForwardAxis = '+x' | '-x' | '+y' | '-y';

/** Rectangular grid of coefficients: rows follow `alphaDeg`, columns follow `pivotDeg` (both strictly increasing). */
export interface AeroTable {
  readonly alphaDeg: readonly number[];
  readonly pivotDeg: readonly number[];
  readonly cl: readonly (readonly number[])[];
  readonly cd: readonly (readonly number[])[];
  /** Pitching moment about the moment centre, nose-up positive. */
  readonly cm: readonly (readonly number[])[];
}

/**
 * A lifting surface (or a set of surfaces solved together) on a body, with its table and the servo that pivots it.
 * @invariant bodyId is a non-fixed rigid body; refAreaM2, refChordM, refSpanM, airDensity > 0; table axes strictly increasing, >= 2 angles of attack
 * @invariant the forces act at momentCentre (document units, modelled pose): F in the flow frame = q·S·[CD cos α − CL sin α, 0, CD sin α + CL cos α],
 *            moment q·S·c·Cm about the flow-frame y axis through momentCentre; q from the flow in the x-z plane (sideslip is not modelled)
 * @invariant servo non-null iff the pivot axis of the table has more than one angle; its limits lie inside the table's pivot axis
 * @invariant id unique across doc.dynamics records and the flight slice (idTakenInDynamicsOrFlight)
 */
export interface AeroSurface {
  readonly id: string;
  readonly bodyId: string;
  readonly momentCentre: Vec3;
  readonly forward: ForwardAxis;
  readonly refAreaM2: number;
  readonly refChordM: number;
  readonly refSpanM: number;
  readonly airDensity: number;
  readonly table: AeroTable;
  /** Angle-of-attack range the table is valid in (the stall bound when a clMax was given), deg. */
  readonly validAlphaDeg: readonly [number, number];
  readonly profileDrag: { readonly cd0: number; readonly clMax: number | null; readonly source: string | null };
  readonly provenance: 'vlm+polar';
  /** True unless the profile drag came from a stated source. */
  readonly unverified: boolean;
  readonly servo: {
    readonly rateDegS: number;
    readonly minDeg: number;
    readonly maxDeg: number;
    /** Angle at t = 0 unless a set-point at 0 names one, deg. */
    readonly neutralDeg: number;
  } | null;
  /** Hash of the generation inputs and of the body design the table was made on (see aeroDesignHash). */
  readonly inputsHash: string;
  readonly designHash: string;
  readonly solver: { readonly engine: string; readonly panels: number; readonly calls: number };
  readonly defaulted: readonly string[];
}

/** Unit vectors of the flow frame (x downstream, y spanwise, z up) in body axes. */
export function flowFrame(forward: ForwardAxis): { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3 } {
  const x: Vec3 = forward === '+x' ? [-1, 0, 0] : forward === '-x' ? [1, 0, 0] : forward === '+y' ? [0, -1, 0] : [0, 1, 0];
  // y = z × x
  const y: Vec3 = [-x[1], x[0], 0];
  return { x, y, z: [0, 0, 1] };
}
