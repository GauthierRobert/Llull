/** Unit conversions into the analysis unit systems of 05 §5.6 (N-mm-t-s, N-m-kg-s, lbf-in-slinch-s). */

import type { UnitSystem } from '@core/model/analysis';
import type { DocumentUnit } from '@core/model/types';
import { toMetres } from '@core/model/units';

const PSI_PER_MPA = 145.03773773;
const KG_PER_SLINCH = 175.12683525;
const METRES_PER_INCH = 0.0254;

/** Multiply a stress in MPa by this to get the unit-system stress (N-mm-t-s: MPa, N-m-kg-s: Pa, lbf-in-slinch-s: psi). */
export function stressPerMpa(unitSystem: UnitSystem): number {
  if (unitSystem === 'N-mm-t-s') return 1;
  return unitSystem === 'N-m-kg-s' ? 1e6 : PSI_PER_MPA;
}

/** Name of the stress unit of a unit system. */
export function stressUnitName(unitSystem: UnitSystem): string {
  if (unitSystem === 'N-mm-t-s') return 'MPa';
  return unitSystem === 'N-m-kg-s' ? 'Pa' : 'psi';
}

/** Name of the length unit of a unit system. */
export function lengthUnitName(unitSystem: UnitSystem): string {
  if (unitSystem === 'N-mm-t-s') return 'mm';
  return unitSystem === 'N-m-kg-s' ? 'm' : 'in';
}

/**
 * Material density (grams per cubic document unit, as `Material.density`) in the unit-system density
 * (N-mm-t-s: t/mm^3, N-m-kg-s: kg/m^3, lbf-in-slinch-s: slinch/in^3).
 */
export function densityToAnalysis(density: number, documentUnit: DocumentUnit, unitSystem: UnitSystem): number {
  const kgPerCubicMetre = (density * 1e-3) / toMetres({ units: documentUnit }, 1) ** 3;
  if (unitSystem === 'N-m-kg-s') return kgPerCubicMetre;
  return unitSystem === 'N-mm-t-s' ? kgPerCubicMetre * 1e-12 : (kgPerCubicMetre * METRES_PER_INCH ** 3) / KG_PER_SLINCH;
}
