import { HoistingClass } from './frameModelTypes';
import { E_STEEL } from './steelDesign';

export type CraneClass = 'S2' | 'S3' | 'S4';

export type GirderType = 'rolled' | 'welded-full' | 'welded-fillet';

export type RailSize = 'A45' | 'A55' | 'A65' | 'A75' | 'A100' | 'flat50x30';

/** Approximate crane-rail data (DIN 536 Form A; flat bar 50x30): height mm, foot width mm, kg/m, Ir mm⁴. */
export const RAILS: Readonly<
  Record<RailSize, { height: number; foot: number; mass: number; inertia: number }>
> = {
  A45: { height: 55, foot: 125, mass: 22.1, inertia: 90e4 },
  A55: { height: 65, foot: 150, mass: 31.8, inertia: 178e4 },
  A65: { height: 75, foot: 175, mass: 43.1, inertia: 319e4 },
  A75: { height: 85, foot: 200, mass: 56.2, inertia: 531e4 },
  A100: { height: 95, foot: 200, mass: 74.3, inertia: 856e4 },
  flat50x30: { height: 30, foot: 50, mass: 11.8, inertia: 11.25e4 },
};

export interface RunwayCheckParams {
  railSize?: RailSize;
  girder?: GirderType;
  craneCapacity?: number;
  wheelBase?: number;
  craneClass?: CraneClass;
  hoistingClass?: HoistingClass;
  hoistingSpeed?: number;
  craneSpan?: number;
  craneSelfWeight?: number;
  minHookApproach?: number;
  travelSpeed?: number;
  bufferStiffness?: number;
  levelId?: string;
}

export interface RunwayCheckRow {
  readonly elementId: string;
  readonly mark: string;
  readonly profile: string;
  /** Segment length, mm. */
  readonly span: number;
  readonly kind: 'strength' | 'ltb' | 'deflection' | 'fatigue' | 'local';
  readonly check: string;
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly utilisation: number;
}

export const GAMMA_ULS = 1.35;

/** Bridge span (mm) when no paired runway beam is found and craneSpan is not given. */
export const DEFAULT_CRANE_SPAN = 20000;

export const DEFLECTION_RATIO = 600;

export const FATIGUE_PHI = 1.05;

export const FATIGUE_CATEGORY = 71;

// N/mm²
export const GAMMA_MF = 1.15;

export const GAMMA_M0 = 1;

/** EN 1993-1-9 Tab. 8.10: rolled 160; welded full-penetration tee-butt 71; fillet / partial penetration 36. */
export const LOCAL_CATEGORIES: Readonly<Record<GirderType, number>> = {
  rolled: 160,
  'welded-full': 71,
  'welded-fillet': 36,
};

export const LOCAL_LAMBDA_FACTOR = 1.26;

// 2^(1/3): two stress cycles per wheel passage (EN 1993-6 §9.4.2)
export const RAIL_WEAR_INERTIA_FACTOR = 0.75;

// simplified Ir reduction for 25 % head wear (EN 1993-6 §5.6.2(2))
/** Damage-equivalent factors λ for normal stresses (EN 1991-3 Tab. 2.12). */
export const CLASSES: Readonly<Record<CraneClass, number>> = { S2: 0.315, S3: 0.397, S4: 0.5 };

/** EN 1991-3 §2.11.1 buffer factor φ7 for a buffer characteristic ξb ≤ 0.5. */
export const PHI7 = 1.25;

/** v1 = 0.7 × long travel speed (EN 1991-3 §2.11.1). */
export const BUFFER_SPEED_RATIO = 0.7;

/** EN 1991-3 Tab. A.1: partial factor of load group 7 (accidental-type buffer impact). */
export const GAMMA_BUFFER = 1;

/** EN 1991-3 Tab. A.1: partial factor of the test load (group 8). */
export const GAMMA_TEST = 1.1;

/** Long travel speed (m/s, about 38 m/min) and buffer spring constant (kN/m) defaults. */
export const DEFAULT_TRAVEL_SPEED = 0.63;

export const DEFAULT_BUFFER_STIFFNESS = 1000;

/** Static test load factor on Qh (EN 1991-3 §2.10). */
export const STATIC_TEST_FACTOR = 1.25;

/** Dynamic test load factor on Qh (EN 1991-3 §2.10). */
export const DYNAMIC_TEST_FACTOR = 1.1;

/**
 * Total buffer force HB,1 = φ7 v1 √(mc SB) (N) of the crane at both end stops of a runway.
 * mc = crane mass only (free hook); v1 = 0.7 × travelSpeed (m/s); stiffness in kN/m.
 */
export function bufferForce(
  craneSelfWeightNewton: number,
  travelSpeed: number,
  stiffnessKnPerM: number,
): number {
  const mass = craneSelfWeightNewton / 9.81;
  return PHI7 * BUFFER_SPEED_RATIO * travelSpeed * Math.sqrt(mass * stiffnessKnPerM * 1000);
}

/** Maximum moment (N·mm) of two wheel loads P at spacing a on a simply supported span L. */
export function wheelMoment(load: number, spacing: number, span: number): number {
  return spacing < 0.586 * span
    ? (load * (span - spacing / 2) ** 2) / (2 * span)
    : (load * span) / 4;
}

/** Maximum support shear (N) of two wheel loads P at spacing a on span L (one wheel at support). */
export function wheelShear(load: number, spacing: number, span: number): number {
  return load * Math.max(1, 2 - spacing / span);
}

/** Midspan deflection (mm) of two wheel loads P placed symmetrically about midspan (exact). */
export function wheelDeflection(
  load: number,
  spacing: number,
  span: number,
  inertia: number,
): number {
  const wheels = spacing < span ? 2 : 1;
  const x = wheels === 2 ? (span - spacing) / 2 : span / 2;
  return (wheels * load * x * (3 * span ** 2 - 4 * x ** 2)) / (48 * E_STEEL * inertia);
}

export function round(value: number, digits = 2): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}
