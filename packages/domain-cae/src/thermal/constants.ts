/** Named physical constants of radiation cases (PHY-03 FR-THM-20, VC-THM-60): value, unit, source, defaulted. */

import type { Named, TemperatureScale, ThermalSetup } from '@core/model/analysis';
import { STEFAN_BOLTZMANN } from '@lib/thermalClosedForms';
import { absoluteZeroOf } from './quantities';

/** Named default: heat-balance residual above which `THM_HEAT_BALANCE` warns. */
export const HEAT_BALANCE_TOLERANCE: Named = { value: 1e-2, unit: '1', source: 'llull acceptance rule', defaulted: true };

/** True when any radiation BC or cavity exists (the deck then needs `*PHYSICAL CONSTANTS`). */
export const hasRadiation = (thermal: ThermalSetup): boolean =>
  Object.keys(thermal.cavities).length > 0 || Object.values(thermal.bcs).some((record) => record.bc.kind === 'radiation');

export const physicalConstantsOf = (scale: TemperatureScale): { stefanBoltzmann: Named; absoluteZero: Named } => ({
  stefanBoltzmann: { value: STEFAN_BOLTZMANN, unit: 'W/(m^2 K^4)', source: '2019 SI exact constants', defaulted: true },
  absoluteZero: { value: absoluteZeroOf(scale), unit: scale, source: 'SI definition of degC', defaulted: true },
});
