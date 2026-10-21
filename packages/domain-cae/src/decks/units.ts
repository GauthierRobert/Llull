/** Unit conversions into the analysis unit systems of 05 §5.6 (N-mm-t-s, N-m-kg-s, lbf-in-slinch-s). */

import type { UnitSystem } from '@core/model/analysis';
import type { CadDocument, DocumentUnit } from '@core/model/types';
import { toMetres, toMm } from '@core/model/units';

const KG_PER_SLINCH = 175.12683525;

/** Every per-unit-system constant of 05 §5.6: the single place the three systems are told apart. */
export interface UnitSystemFactors {
  /** Metres in one length unit. */
  readonly metresPerLength: number;
  /** Millimetres in one length unit. */
  readonly mmPerLength: number;
  /** Multiply a stress in MPa by this. */
  readonly stressPerMpa: number;
  /** Newton-millimetres in one force-length (energy) unit. */
  readonly nmmPerForceLength: number;
  readonly lengthUnit: string;
  readonly stressUnit: string;
  /** Energy unit name; null when the explicit solver does not support the system. */
  readonly energyUnit: string | null;
}

const FACTORS: Readonly<Record<UnitSystem, UnitSystemFactors>> = {
  'N-mm-t-s': {
    metresPerLength: 0.001,
    mmPerLength: 1,
    stressPerMpa: 1,
    nmmPerForceLength: 1,
    lengthUnit: 'mm',
    stressUnit: 'MPa',
    energyUnit: 'mJ',
  },
  'N-m-kg-s': {
    metresPerLength: 1,
    mmPerLength: 1000,
    stressPerMpa: 1e6,
    nmmPerForceLength: 1000,
    lengthUnit: 'm',
    stressUnit: 'Pa',
    energyUnit: 'J',
  },
  'lbf-in-slinch-s': {
    metresPerLength: 0.0254,
    mmPerLength: 25.4,
    stressPerMpa: 145.03773773,
    nmmPerForceLength: 4.4482216152605 * 25.4,
    lengthUnit: 'in',
    stressUnit: 'psi',
    energyUnit: null,
  },
};

export const unitSystemFactors = (unitSystem: UnitSystem): UnitSystemFactors => FACTORS[unitSystem];

/** Multiply a stress in MPa by this to get the unit-system stress (N-mm-t-s: MPa, N-m-kg-s: Pa, lbf-in-slinch-s: psi). */
export const stressPerMpa = (unitSystem: UnitSystem): number => FACTORS[unitSystem].stressPerMpa;

/** Name of the stress unit of a unit system. */
export const stressUnitName = (unitSystem: UnitSystem): string => FACTORS[unitSystem].stressUnit;

/** Name of the length unit of a unit system. */
export const lengthUnitName = (unitSystem: UnitSystem): string => FACTORS[unitSystem].lengthUnit;

/** A length in document units expressed in the length unit of the analysis unit system. */
export function toAnalysisLength(doc: Pick<CadDocument, 'units'>, unitSystem: UnitSystem, value: number): number {
  return unitSystem === 'N-m-kg-s' ? toMetres(doc, value) : toMm(doc, value) / FACTORS[unitSystem].mmPerLength;
}

/**
 * Material density (grams per cubic document unit, as `Material.density`) in the unit-system density
 * (N-mm-t-s: t/mm^3, N-m-kg-s: kg/m^3, lbf-in-slinch-s: slinch/in^3).
 */
export function densityToAnalysis(density: number, documentUnit: DocumentUnit, unitSystem: UnitSystem): number {
  const kgPerCubicMetre = (density * 1e-3) / toMetres({ units: documentUnit }, 1) ** 3;
  if (unitSystem === 'N-m-kg-s') return kgPerCubicMetre;
  return unitSystem === 'N-mm-t-s'
    ? kgPerCubicMetre * 1e-12
    : (kgPerCubicMetre * FACTORS['lbf-in-slinch-s'].metresPerLength ** 3) / KG_PER_SLINCH;
}
