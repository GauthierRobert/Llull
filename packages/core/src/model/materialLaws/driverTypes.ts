/** Types of the material-point driver (PHY-02 §5.3): path, rows, warnings. Stresses in MPa, time in s, temperature in K. */

import type { MatlIssue } from './issues';
import type { LawFailure } from './resolve';

export const COMPONENTS = ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'] as const;
export type Component = (typeof COMPONENTS)[number];

export const PRESETS = ['uniaxial_stress', 'uniaxial_strain', 'plane_strain', 'equibiaxial', 'pure_shear', 'simple_shear'] as const;
export type Preset = (typeof PRESETS)[number];

/** One component controlled by a strain (dimensionless; engineering shear for xy xz yz) or a stress (MPa). */
export type ComponentControl = { readonly strain: number } | { readonly stress: number };

export interface PathStep {
  /** Duration in seconds (named default 1 s). */
  readonly duration: number | null;
  readonly temperatureK: number | null;
  readonly increments: number;
  readonly control: Readonly<Partial<Record<Component, ComponentControl>>>;
}

export interface DriverRow {
  readonly step: number;
  readonly increment: number;
  readonly time: number;
  readonly T: number | null;
  readonly strain: readonly number[];
  readonly stress: readonly number[];
  readonly eqPlasticStrain: number;
  readonly vonMises: number;
  readonly backStress: readonly number[];
  readonly energyDensity: number;
  readonly eqCreepStrain?: number;
  readonly stretch?: readonly number[];
  readonly nominalStress?: number;
  /** Volume ratio J = det F (compressible finite runs). */
  readonly volumeRatio?: number;
}

export interface DriverWarning {
  readonly code: string;
  readonly step: number;
  readonly increment: number;
  readonly message: string;
}

export interface DriverFailure extends LawFailure {
  readonly step?: number;
  readonly increment?: number;
}

export interface DriverOutcome {
  readonly rows: readonly DriverRow[];
  readonly warnings: readonly DriverWarning[];
  /** Issues of the models themselves (not of the path) discovered while resolving them at a step. */
  readonly issues: readonly MatlIssue[];
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean;
  readonly usedDefaults: ReadonlySet<string>;
}

/** Increment limit of the command (about 5 s of Chaboche); callers of the driver itself may raise it with `maxIncrements`. */
export const MAX_TOTAL_INCREMENTS = 100_000;
export const MAX_ROWS = 10_000;
export const DEFAULT_INCREMENTS = 100;
export const DEFAULT_DURATION_SECONDS = 1;
