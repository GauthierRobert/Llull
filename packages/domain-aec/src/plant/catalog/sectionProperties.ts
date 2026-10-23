/**
 * Pipe section properties (TR-PSC-09, §5.3): areas, second moment, section modulus and mass per metre of a round pipe from OD and wall.
 * Plain-end steel mass m = rho_s pi (D - t) t 1e-6 = 0.0246615 (D - t) t kg/m for 7850 kg/m3 [S16, S17].
 */

import { GRAVITY } from '../../shared/numeric';

/** Carbon steel, the named default of `pipe_section_properties`. */
export const STEEL_DENSITY_KG_M3 = 7850;

export interface SectionInput {
  readonly odMm: number;
  readonly wallMm: number;
  readonly steelDensityKgM3: number;
  readonly contentDensityKgM3: number;
  readonly insulation?: { readonly thicknessMm: number; readonly densityKgM3: number };
}

export interface SectionProperties {
  readonly insideDiameterMm: number;
  readonly metalAreaMm2: number;
  readonly flowAreaMm2: number;
  readonly secondMomentMm4: number;
  readonly sectionModulusMm3: number;
  readonly massKgPerM: number;
  readonly contentMassKgPerM: number;
  readonly insulationMassKgPerM: number;
  readonly totalMassKgPerM: number;
  readonly weightKnPerM: number;
}

/**
 * @failure od <= 0, wall <= 0 or wall >= od / 2 -> null
 */
export function sectionProperties(input: SectionInput): SectionProperties | null {
  const { odMm: d, wallMm: t } = input;
  if (!(d > 0) || !(t > 0) || 2 * t >= d) return null;
  const inside = d - 2 * t;
  const metalArea = Math.PI * (d - t) * t;
  const flowArea = (Math.PI / 4) * inside ** 2;
  const secondMoment = (Math.PI / 64) * (d ** 4 - inside ** 4);
  const mass = (input.steelDensityKgM3 * metalArea) / 1e6;
  const content = (input.contentDensityKgM3 * flowArea) / 1e6;
  const insulation =
    input.insulation === undefined
      ? 0
      : (input.insulation.densityKgM3 * (Math.PI / 4) * ((d + 2 * input.insulation.thicknessMm) ** 2 - d ** 2)) / 1e6;
  const total = mass + content + insulation;
  return {
    insideDiameterMm: inside,
    metalAreaMm2: metalArea,
    flowAreaMm2: flowArea,
    secondMomentMm4: secondMoment,
    sectionModulusMm3: (2 * secondMoment) / d,
    massKgPerM: mass,
    contentMassKgPerM: content,
    insulationMassKgPerM: insulation,
    totalMassKgPerM: total,
    weightKnPerM: (total * GRAVITY) / 1000,
  };
}
