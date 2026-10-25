/**
 * Open-bar welded steel grating catalogue (06 STA §5.4, NAAMM MBG 531 basis: plain bearing bars, W = welded cross bars at 4 in).
 * Geometry comes from the designation; only the row marked `verified` has its mass checked against two manufacturer tables.
 */

import { MM_PER_INCH, PSF_TO_KG_M2, PSI_TO_MPA } from './imperial';

/** Standards the catalogue can be filtered by; the metric (RAL-GZ / EN) tables need two manufacturer sources first (spec Q3). */
export const GRATING_STANDARDS = ['naamm_mbg_531'] as const;

export interface GratingType {
  /** Catalogue key, e.g. "19-W-4 1-1/4x3/16" (19/16 in bar pitch, welded, 4 in cross bars; 1-1/4 in deep, 3/16 in thick bars). */
  readonly name: string;
  readonly standard: (typeof GRATING_STANDARDS)[number];
  readonly barDepthMm: number;
  readonly barThicknessMm: number;
  /** Bearing-bar pitch (centre to centre), mm. */
  readonly barPitchMm: number;
  readonly crossBarPitchMm: number;
  /** Mass of the panel per plan area, kg/m². */
  readonly massKgM2: number;
  /** Mass and geometry checked against two manufacturer tables. */
  readonly verified: boolean;
  readonly massSource: string;
}

/** Allowable bending stress F (18 000 psi) and modulus E (29 000 ksi) of the NAAMM steel load tables, MPa (source S19). */
export const ALLOWABLE_STRESS_MPA = 18000 * PSI_TO_MPA;
export const ELASTIC_MODULUS_MPA = 29_000_000 * PSI_TO_MPA;

const STEEL_DENSITY_KG_M3 = 7850;

/** Published mass of 19-W-4 1-1/4x3/16: 8.9 psf (manufacturer tables S20 and S21), kg/m². */
const VERIFIED_MASS_KG_M2 = 8.9 * PSF_TO_KG_M2;

interface BarSection {
  readonly pitchMm: number;
  readonly depthMm: number;
  readonly thicknessMm: number;
}

/** Bearing bars alone, kg/m². */
const barsMassKgM2 = ({ pitchMm, depthMm, thicknessMm }: BarSection): number =>
  (1000 / pitchMm) * depthMm * thicknessMm * 1e-6 * STEEL_DENSITY_KG_M3;

/** Cross bars and banding as a share of the bearing-bar mass, calibrated on the published 19-W-4 1-1/4x3/16 row. */
const CROSS_BAR_FACTOR =
  VERIFIED_MASS_KG_M2 /
  barsMassKgM2({ pitchMm: (19 / 16) * MM_PER_INCH, depthMm: 1.25 * MM_PER_INCH, thicknessMm: (3 / 16) * MM_PER_INCH });

const VERIFIED_NAME = '19-W-4 1-1/4x3/16';

const row = (designation: string, pitchIn: number, depthLabel: string, depthIn: number): GratingType => {
  const section: BarSection = { pitchMm: pitchIn * MM_PER_INCH, depthMm: depthIn * MM_PER_INCH, thicknessMm: (3 / 16) * MM_PER_INCH };
  const name = `${designation} ${depthLabel}x3/16`;
  const verified = name === VERIFIED_NAME;
  return {
    name,
    standard: 'naamm_mbg_531',
    barDepthMm: section.depthMm,
    barThicknessMm: section.thicknessMm,
    barPitchMm: section.pitchMm,
    crossBarPitchMm: 4 * MM_PER_INCH,
    massKgM2: verified ? VERIFIED_MASS_KG_M2 : barsMassKgM2(section) * CROSS_BAR_FACTOR,
    verified,
    massSource: verified
      ? '8.9 psf, Grating Pacific and Marco Specialty Steel 19-W-4 tables (S20, S21)'
      : 'computed: bearing bars plus the cross-bar share calibrated on 19-W-4 1-1/4x3/16 (not checked against a manufacturer table)',
  };
};

const DEPTHS: ReadonlyArray<readonly [string, number]> = [
  ['1', 1],
  ['1-1/4', 1.25],
  ['1-1/2', 1.5],
  ['1-3/4', 1.75],
  ['2', 2],
];

export const GRATING_TYPES: ReadonlyArray<GratingType> = [
  ...DEPTHS.map(([label, depth]) => row('19-W-4', 19 / 16, label, depth)),
  ...DEPTHS.slice(1, 3).map(([label, depth]) => row('15-W-4', 15 / 16, label, depth)),
];

export const findGratingType = (name: string): GratingType | undefined => GRATING_TYPES.find((type) => type.name === name);

/** Section modulus (mm³) and second moment of area (mm⁴) of the bearing bars per metre of grating width. */
export function sectionPerMetre(type: GratingType): { readonly modulus: number; readonly inertia: number } {
  const bars = 1000 / type.barPitchMm;
  return {
    modulus: (bars * type.barThicknessMm * type.barDepthMm ** 2) / 6,
    inertia: (bars * type.barThicknessMm * type.barDepthMm ** 3) / 12,
  };
}
