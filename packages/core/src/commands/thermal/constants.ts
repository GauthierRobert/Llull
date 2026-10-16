/** Named physical constants of the thermal pack: value, unit, source, defaulted (PHY-03 VC-THM-60, AF-31). */

import { STEFAN_BOLTZMANN } from '../../lib/thermalClosedForms';

export interface NamedConstant {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly defaulted: boolean;
}

export interface PhysicalConstants {
  readonly stefanBoltzmann: NamedConstant;
  readonly absoluteZero: NamedConstant;
}

export const physicalConstants = (): PhysicalConstants => ({
  stefanBoltzmann: { value: STEFAN_BOLTZMANN, unit: 'W/(m^2 K^4)', source: '2019 SI exact constants', defaulted: true },
  absoluteZero: { value: -273.15, unit: 'degC', source: 'SI definition of degC', defaulted: true },
});
