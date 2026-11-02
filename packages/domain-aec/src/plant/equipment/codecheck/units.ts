/** Pressure and stress to MPa (the unit of every code formula here). Exact factors: 1 psi = 6894.757293168 Pa, 1 bar = 0.1 MPa. */

import type { PressureUnit, StressUnit } from '../plantData';

const MPA_PER_PSI = 0.006894757293168;

export const pressureToMpa = (value: number, unit: PressureUnit): number =>
  unit === 'MPa' ? value : unit === 'kPa' ? value / 1000 : unit === 'bar' ? value / 10 : value * MPA_PER_PSI;

export const stressToMpa = (value: number, unit: StressUnit): number => (unit === 'MPa' ? value : value * MPA_PER_PSI);
