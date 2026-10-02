/**
 * frameModel: frameModelTypes.
 * @layer core/commands/building
 */

import type { SteelMemberElement } from '@core/model/building';
import type { FrameMember, FrameNode } from '@lib/frame2d';
import type { CoefficientSet } from './windCoefficients';

/**
 * G dead, S snow, WL / WR wind from the left (+x) / right with internal pressure cpi = +0.2,
 * WLs / WRs the same with internal suction cpi = −0.3, CL / CR crane load group 1 (EN 1991-3 Tab. 2.2:
 * φ1 Gc + φ2 Q + drive forces) with the maximum wheel load at the left / right rail, CL5 / CR5 load
 * group 5 (φ4 + skewing HS) likewise, CLk / CRk the serviceability version of group 1 (static wheel
 * loads, φ = 1, drive force HT / φ5; EN 1993-6 §7.3). WLp / WRp: wind from the left / right with the
 * roof pressure set (EN 1991-1-4 Tab. 7.3a / 7.4a / 7.2: positive on the windward slope) and cpi = −0.3.
 */
export type LoadCase =
  | 'G'
  | 'S'
  | 'WL'
  | 'WR'
  | 'WLs'
  | 'WRs'
  | 'WLp'
  | 'WRp'
  | 'CL'
  | 'CR'
  | 'CL5'
  | 'CR5'
  | 'CLk'
  | 'CRk';

export interface WindCase {
  readonly loadCase: 'WL' | 'WR' | 'WLs' | 'WRs' | 'WLp' | 'WRp';
  readonly from: 'left' | 'right';
  readonly internalPressure: number;
  /** Roof coefficient set of EN 1991-1-4 (`suction` = large windward suction, `pressure` = alternative). */
  readonly roofSet: CoefficientSet;
  /** Combination label, e.g. "W→" or "W←(cpi−0.3)". */
  readonly label: string;
}

/** The four base wind cases (EN 1991-1-4 §7.2.9: cpi +0.2 / −0.3 when openings are not dominant). */
export const WIND_CASES: ReadonlyArray<WindCase> = [
  { loadCase: 'WL', from: 'left', internalPressure: 0.2, roofSet: 'suction', label: 'W→' },
  { loadCase: 'WR', from: 'right', internalPressure: 0.2, roofSet: 'suction', label: 'W←' },
  {
    loadCase: 'WLs',
    from: 'left',
    internalPressure: -0.3,
    roofSet: 'suction',
    label: 'W→(cpi−0.3)',
  },
  {
    loadCase: 'WRs',
    from: 'right',
    internalPressure: -0.3,
    roofSet: 'suction',
    label: 'W←(cpi−0.3)',
  },
];

/**
 * Roof pressure-set cases (cpi −0.3): present on a frame only when `FrameModel.windCases` lists them
 * (a rafter sees cpe ≥ ROOF_PRESSURE_CASE_MIN_CPE). Use `windCasesOf(frames)` to iterate the cases
 * that carry load.
 */
export const WIND_PRESSURE_CASES: ReadonlyArray<WindCase> = [
  {
    loadCase: 'WLp',
    from: 'left',
    internalPressure: -0.3,
    roofSet: 'pressure',
    label: 'W→(roof pressure)',
  },
  {
    loadCase: 'WRp',
    from: 'right',
    internalPressure: -0.3,
    roofSet: 'pressure',
    label: 'W←(roof pressure)',
  },
];

/** A pressure-set case is generated when a rafter sees at least this cpe,10 (positive = pressure). */
export const ROOF_PRESSURE_CASE_MIN_CPE = 0.15;

/** The wind cases that carry load on at least one of the frames. */
export function windCasesOf(frames: ReadonlyArray<Pick<FrameModel, 'windCases'>>): WindCase[] {
  return [...WIND_CASES, ...WIND_PRESSURE_CASES].filter(
    (windCase) =>
      windCase.roofSet === 'suction' ||
      frames.some((frame) => frame.windCases.some((own) => own.loadCase === windCase.loadCase)),
  );
}

/** Uniform member load per unit length, global components (N/mm). */
export type CaseLoads = Partial<Record<LoadCase, { readonly qx: number; readonly qy: number }>>;

export interface AnalysisMember {
  readonly geometry: Omit<FrameMember, 'load'>;
  readonly elementId: string;
  readonly role: 'column' | 'rafter';
  /** True when the analysis member runs end → start of the element (kept left → right / up). */
  readonly reversed: boolean;
  /** True for the first / last analysis piece of the element (connection ends). */
  readonly ends: readonly [boolean, boolean];
  readonly loads: CaseLoads;
  /**
   * Buckling lengths (mm): in-plane system length, out-of-plane flexural length and the spacing
   * of lateral-torsional restraints (purlins / side rails with fly braces to the inner flange).
   */
  readonly lengths: {
    readonly major: number;
    readonly minor: number;
    readonly lateralTorsional: number;
  };
}

export interface NodeCaseLoad {
  readonly node: number;
  readonly loadCase: LoadCase;
  readonly fx: number;
  readonly fy: number;
  readonly mz: number;
}

export interface FrameModel {
  readonly label: string;
  readonly nodes: FrameNode[];
  readonly members: AnalysisMember[];
  /** Wind cases with load on this frame: the four base cases + the roof pressure cases that apply. */
  readonly windCases: ReadonlyArray<WindCase>;
  readonly nodeLoads: NodeCaseLoad[];
  /** Column tops (mm above the base) — sway / imperfection / Horne loads act here. */
  readonly columnTops: ReadonlyArray<{ node: number; height: number; elementId: string }>;
  /** Crane bracket nodes (mm above the base) — lateral deflection at rail level. */
  readonly craneNodes: ReadonlyArray<{ node: number; height: number; elementId: string }>;
  /** Spans between adjacent column tops, [x0, x1] mm. */
  readonly spans: ReadonlyArray<readonly [number, number]>;
}

export interface FrameLoads {
  /** kN/m². */
  readonly deadLoad: number;
  readonly snowLoad: number;
  /** Peak velocity pressure qp, kN/m² (0 = no wind). */
  readonly windPressure: number;
  /** Crane capacity override, t (undefined = from the runway, 0 = ignore cranes). */
  readonly craneCapacity?: number;
  /** Crane model overrides (EN 1991-3); undefined fields take the defaults of `craneActions`. */
  readonly craneModel?: CraneModel;
}

/** Simplified external pressure coefficients of the walls (EN 1991-1-4 zones D / E). Roofs: `windCoefficients.ts`. */
export const WIND_COEFFICIENTS = { windward: 0.8, leeward: 0.5 } as const;

/** Crane capacity (t) from the runway note written by add_crane_runway ("Crane 10 t, …"). */
export function craneCapacityOf(member: SteelMemberElement): number | null {
  const value = Number(/^Crane\s+(\d+(?:\.\d+)?)\s*t\b/.exec(member.note ?? '')?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type HoistingClass = 'HC1' | 'HC2' | 'HC3' | 'HC4';

/** EN 1991-3 Tab. 2.5: φ2 = φ2,min + β2 vh. */
export const HOISTING_CLASSES: Readonly<
  Record<HoistingClass, { readonly beta2: number; readonly phi2Min: number }>
> = {
  HC1: { beta2: 0.17, phi2Min: 1.05 },
  HC2: { beta2: 0.34, phi2Min: 1.1 },
  HC3: { beta2: 0.51, phi2Min: 1.15 },
  HC4: { beta2: 0.68, phi2Min: 1.2 },
};

/**
 * EN 1991-3 dynamic and drive factors: φ1 on the self-weight, φ4 = 1.0 (rails within tolerance),
 * φ5 = 1.5 (smooth change of the drive force), friction μ = 0.2, nr = 2 rails, skew angle
 * α = 0.015 rad (simplified, §2.7.4).
 */
export const CRANE_FACTORS = {
  phi1: 1.1,
  phi4: 1,
  phi5: 1.5,
  friction: 0.2,
  rails: 2,
  skewAngle: 0.015,
} as const;

export interface CraneModel {
  readonly hoistingClass?: HoistingClass;
  /** Hoisting speed vh, m/s. Default 0.1. */
  readonly hoistingSpeed?: number;
  /** Crane self-weight Gc, kN (bridge + trolley). Default 0.5 Q + 20 kN. */
  readonly craneSelfWeight?: number;
  /** Minimum hook approach to the rail, m. Default 1.0. */
  readonly minHookApproach?: number;
  /** Wheel base a of a rail wheel group, mm. Default 3000. */
  readonly wheelBase?: number;
}

export interface CraneActions {
  /** Dynamic factor φ2 = φ2,min + β2 vh. */
  readonly phi2: number;
  /** Crane self-weight Gc, N. */
  readonly selfWeight: number;
  /** Static (characteristic, no dynamic factor) rail reactions, N per rail. */
  readonly staticMax: number;
  readonly staticMin: number;
  /** Load group 1: φ1 Gc + φ2 Q with HL, HT. N per rail. */
  readonly group1: {
    readonly max: number;
    readonly min: number;
    /** Longitudinal drive force HL,i = φ5 K / nr per rail. */
    readonly longitudinal: number;
    /** Transverse drive force on the heavily / lightly loaded rail (HT,1 / HT,2). */
    readonly transverseMax: number;
    readonly transverseMin: number;
  };
  /** Load group 5: φ4 (Gc + Q) with skewing forces HS. N per rail. */
  readonly group5: {
    readonly max: number;
    readonly min: number;
    readonly skewMax: number;
    readonly skewMin: number;
  };
}

/**
 * Characteristic crane actions per rail (N) of one bridge crane, EN 1991-3 §2.
 * Statics: bridge 0.8 Gc at midspan, trolley 0.2 Gc + hoist load Q at the minimum hook approach e;
 * Rmax = 0.4 Gc + (0.2 Gc + Q)(l − e)/l, Rmin = 0.4 Gc + (0.2 Gc + Q) e/l (wheel load = rail / 2).
 * Group 1: φ1 on Gc, φ2 on Q; K = μ Σ driven wheel loads (one driven wheel per rail at the minimum static wheel load, Σ = Rmin),
 * HL,i = φ5 K / nr, M = K ls with ls = (ξ1 − 0.5) l, HT,1 = φ5 ξ2 M / a, HT,2 = φ5 ξ1 M / a (same
 * direction on both rails, conservative). Group 5: φ4 = 1 and HS,i = f λS,i ΣQr, f = 0.3(1 − e^(−250 α))
 * with α = 0.015 rad, λS = ξ2 / nr on the loaded rail guide and ξ1 / nr on the other (IFF, simplified).
 * @param span bridge span between the rails, mm
 */
export function craneActions(
  capacityTonnes: number,
  span: number,
  model: CraneModel = {},
): CraneActions {
  const { phi1, phi4, phi5, friction, rails, skewAngle } = CRANE_FACTORS;
  const { beta2, phi2Min } = HOISTING_CLASSES[model.hoistingClass ?? 'HC2'];
  const phi2 = phi2Min + beta2 * (model.hoistingSpeed ?? 0.1);
  const hoist = capacityTonnes * 9810;
  const self =
    model.craneSelfWeight !== undefined ? model.craneSelfWeight * 1000 : 0.5 * hoist + 20000;
  const approach = Math.min(Math.max(0, (model.minHookApproach ?? 1) * 1000), span);
  const wheelBase = model.wheelBase ?? 3000;
  const nearShare = (span - approach) / span;
  const farShare = approach / span;
  const trolleyAndHoist = 0.2 * self + hoist;
  const staticMax = 0.4 * self + trolleyAndHoist * nearShare;
  const staticMin = 0.4 * self + trolleyAndHoist * farShare;
  const dynamic = (share: number): number =>
    phi1 * (0.4 * self + 0.2 * self * share) + phi2 * hoist * share;
  const total = staticMax + staticMin;
  const xi1 = staticMax / total;
  const xi2 = 1 - xi1;
  const drive = friction * staticMin;
  const moment = drive * (xi1 - 0.5) * span;
  const skewFactor = 0.3 * (1 - Math.exp(-250 * skewAngle));
  return {
    phi2,
    selfWeight: self,
    staticMax,
    staticMin,
    group1: {
      max: dynamic(nearShare),
      min: dynamic(farShare),
      longitudinal: (phi5 * drive) / rails,
      transverseMax: (phi5 * xi2 * moment) / wheelBase,
      transverseMin: (phi5 * xi1 * moment) / wheelBase,
    },
    group5: {
      max: phi4 * staticMax,
      min: phi4 * staticMin,
      skewMax: skewFactor * (xi2 / rails) * total,
      skewMin: skewFactor * (xi1 / rails) * total,
    },
  };
}

/** x of the internal valleys (rafter pairs of one plane meeting at their low ends), mm. */
export function valleyLines(
  rafters: ReadonlyArray<{ readonly start: readonly number[]; readonly end: readonly number[] }>,
  tolerance = 10,
): number[] {
  const lowEnds = rafters.map(({ start, end }) => ((start[2] ?? 0) <= (end[2] ?? 0) ? start : end));
  const shared = (end: readonly number[]): boolean =>
    lowEnds.filter(
      (other) =>
        Math.abs((other[0] ?? 0) - (end[0] ?? 0)) <= tolerance &&
        Math.abs((other[1] ?? 0) - (end[1] ?? 0)) <= tolerance,
    ).length >= 2;
  const xs = lowEnds.filter(shared).map((end) => Math.round((end[0] ?? 0) / tolerance) * tolerance);
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Factor on the roof suction of a span downwind of the windward one (EN 1991-1-4 Fig. 7.10, simplified). */
export const DOWNWIND_ROOF_FACTOR = 0.6;
