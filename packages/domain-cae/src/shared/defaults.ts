/** Defaults a new analysis case starts from (named in the creation summary, never silent). */

import type { FactorSet, MeshControls, TemperatureScale, ThermalSetup, UnitSystem } from '@core/model/analysis';
import type { DocumentUnit } from '@core/model/types';

/** Unit system consistent with the document unit: mm/cm -> N-mm-t-s, m -> N-m-kg-s, in/ft -> lbf-in-slinch-s. */
export function unitSystemOf(unit: DocumentUnit): UnitSystem {
  if (unit === 'm') return 'N-m-kg-s';
  return unit === 'in' || unit === 'ft' ? 'lbf-in-slinch-s' : 'N-mm-t-s';
}

/** Metres in one length unit of the analysis unit system. */
export function analysisLengthMetres(unitSystem: UnitSystem): number {
  if (unitSystem === 'N-m-kg-s') return 1;
  return unitSystem === 'N-mm-t-s' ? 0.001 : 0.0254;
}

const DEFAULT_GLOBAL_SIZE: Readonly<Record<DocumentUnit, number>> = { mm: 10, cm: 1, m: 0.01, in: 0.5, ft: 0.04 };

/** Tetrahedra (Gmsh), quadratic, element size 10 mm expressed in document units. */
export const defaultMeshControls = (unit: DocumentUnit): MeshControls => ({
  mesher: 'gmsh',
  elementFamily: 'tet',
  order: 2,
  globalSize: DEFAULT_GLOBAL_SIZE[unit],
  refinements: [],
  optimize: 'default',
});

export const DEFAULT_FACTORS: FactorSet = { ultimate: 1.5, yield: 1.0, extra: [] };

export const emptyThermalSetup = (temperatureScale: TemperatureScale): ThermalSetup => ({
  temperatureScale,
  bcs: {},
  bcOrder: [],
  amplitudes: {},
  cavities: {},
  contacts: {},
  step: {},
  limits: {},
  limitOrder: [],
  dispositions: {},
});
