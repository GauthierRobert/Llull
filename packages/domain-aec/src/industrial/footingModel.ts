/**
 * @layer domain-aec
 */

export const FCK = 25;

// N/mm², C25/30
const FCD = FCK / 1.5;

export const FYK = 500;

// N/mm², B500
export const FYD = 0.87 * FYK;

export const FCTM = 2.6;

export const COVER_MM = 50;

export const BAR_DIAMETERS_MM = [12, 16, 20, 25] as const;

export const SPACINGS_MM = [100, 125, 150, 175, 200, 225, 250] as const;

export const MAX_K = 0.167;

export const C_RD_C = 0.12;

export const MAX_RHO = 0.02;

const NU = 0.6 * (1 - FCK / 250);

export const V_RD_MAX = 0.4 * NU * FCD;

export const FALLBACK_COLUMN_MM = 300;

export const INTEGRATION_STEPS = 200;

/** Control perimeters checked at a = 2d·i/PUNCHING_STEPS (EN 1992-1-1 §6.4.4(2)). */
export const PUNCHING_STEPS = 20;

export const PLAN_STEP_MM = 100;

export const PLAN_MARGIN_MM = 100;

export const MAX_PLAN_MM = 6000;

export const THICKNESS_STEP_MM = 50;

export const MIN_THICKNESS_MM = 300;

export const MAX_THICKNESS_MM = 1500;

/** Plan width, plan length and thickness, mm. */
export type PadSize = readonly [number, number, number];

export interface FootingDesignRow {
  readonly id: string;
  readonly mark: string;
  readonly column: string;
  readonly status: 'designed' | 'failed' | 'unloaded';
  /** Pad size before and after sizing (equal when unchanged or failed). */
  readonly sizeBefore: PadSize;
  readonly sizeAfter: PadSize;
  /** mm; null when not designed. */
  readonly barDiameter: number | null;
  /** mm; null when not designed. */
  readonly spacing: number | null;
  /** mm²/m: governing flexural requirement (>= minimum) and the provided area. */
  readonly asRequired: number;
  readonly asProvided: number | null;
  readonly shearUtilisation: number;
  readonly punchingUtilisation: number;
  /** Distance a (mm) from the face of the governing punching perimeter (<= 2d). */
  readonly punchingDistance: number;
  readonly combination: string;
  readonly note: string;
}

export interface Geometry {
  /** Plan sizes and thickness, mm. */
  readonly widthMm: number;
  readonly lengthMm: number;
  readonly thicknessMm: number;
  /** Column / plate face size along x and y, mm. */
  readonly faceXmm: number;
  readonly faceYmm: number;
  /** Lever arm of the horizontal force above the footing base, m. */
  readonly leverM: number;
}

export interface Load {
  readonly combination: string;
  /** Net vertical (kN, compression +) and base moment (kN·m). */
  readonly normal: number;
  readonly moment: number;
}

export interface Envelope {
  /** Bending per metre width, kN·m/m. */
  readonly momentX: number;
  readonly momentY: number;
  readonly shearX: number;
  readonly shearY: number;
  /** Punching stress (N/mm²) at u1 and at the column face. */
  readonly punching: ReadonlyArray<number>;
  readonly faceStress: number;
  readonly combination: string;
}
