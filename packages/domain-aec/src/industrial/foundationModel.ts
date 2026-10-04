import type { LoadCase } from './frameModelTypes';

export interface FoundationRow {
  /** Column mark. */
  readonly column: string;
  /** Footing mark, or '—' for a plate-only column. */
  readonly footing: string;
  /** Footing id for soil checks, base plate id for plate checks. */
  readonly elementId: string;
  readonly check: string;
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly utilisation: number;
  readonly combination: string;
}

export interface ClayLayer {
  /** Depth of the layer top below the founding level, m. */
  readonly topDepth: number;
  /** Layer thickness, m. */
  readonly thickness: number;
  /** Virgin compression index Cc. */
  readonly compressionIndex: number;
  /** Recompression index Cr (default Cc / 5; only used with preconsolidationPressure). */
  readonly recompressionIndex?: number | undefined;
  /** Initial void ratio e0. */
  readonly voidRatio: number;
  /** Bulk unit weight, kN/m³ (default 19). */
  readonly unitWeight?: number | undefined;
  /** Preconsolidation pressure σ'p, kPa (default: normally consolidated). */
  readonly preconsolidationPressure?: number | undefined;
}

export type Factors = Partial<Record<LoadCase, number>>;

export interface Combination {
  readonly name: string;
  readonly factors: Factors;
}

export const CONCRETE_UNIT_WEIGHT = 25;

// kN/m³
export const BACKFILL_UNIT_WEIGHT = 18;

// kN/m³
export const FRICTION = 0.45;

/** EN 1997-1 DA2 partial factor on sliding resistance. */
export const GAMMA_R_H = 1.1;

export const MAX_UTILISATION = 99;

export const MIN_EFFECTIVE_RATIO = 0.01;

export const TOLERANCE_METRES = 0.1;

/** 2 × H16 B500 bars: 2 × 201 mm² × 435 N/mm², kN. */
export const DEFAULT_TIE_CAPACITY = 175;

// MPa
export const POISSON_RATIO = 0.3;

/** Influence factor of a rigid square footing (elastic half-space; flexible centre = 1.12). */
export const SETTLEMENT_INFLUENCE = 0.88;

export const SETTLEMENT_LIMIT_MM = 25;

export const DIFFERENTIAL_RATIO = 500;

export const WATER_UNIT_WEIGHT = 9.81;

// kN/m³
export const DEFAULT_CLAY_UNIT_WEIGHT = 19;

// kN/m³
export const CONSOLIDATION_SUBLAYERS = 5;
