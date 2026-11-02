/**
 * API 650 tables as data (plant 03 EQP §5.6): allowable stresses of Table 5-2a and the minimum nominal shell thickness by tank diameter.
 * The standard is paywalled; rows are public extracts cross-checked between independent sources
 * (validation/data/api650_references.json). Every row carries its grade: below A it makes the result report `unverified` (AF-32).
 */

import type { SourceGrade } from '../model';

export interface TankMaterialRow {
  readonly material: string;
  /** Normalised aliases (upper case, no spaces / dashes / dots / "GR"). */
  readonly aliases: readonly string[];
  readonly designStressMPa: number;
  readonly testStressMPa: number;
  readonly grade: SourceGrade;
  readonly sources: readonly string[];
}

export const TANK_MATERIALS: readonly TankMaterialRow[] = [
  {
    material: 'A283M Gr C',
    aliases: ['A283MC', 'A283C'],
    designStressMPa: 137,
    testStressMPa: 154,
    grade: 'A',
    sources: ['API 650 Table 5-2a extract', 'PPNS example (journal.ppns.ac.id CPEAA 1520)'],
  },
  {
    material: 'A36M',
    aliases: ['A36M', 'A36'],
    designStressMPa: 160,
    testStressMPa: 171,
    grade: 'A',
    sources: ['API 650 Table 5-2a extract', 'second calculation sheet'],
  },
  {
    material: 'A516M Gr 485 (A516 Gr 70)',
    aliases: ['A516M485', 'A516M485A51670', 'A51670', 'A516M70', 'A516485'],
    designStressMPa: 173,
    testStressMPa: 195,
    grade: 'A',
    sources: ['API 650 Table 5-2a extract', 'calculation sheet (one printout shows the unrounded 174.4 / 196.5 MPa, not used)'],
  },
];

export interface MinimumThicknessRow {
  /** The row applies to diameters D (m) with from <= D < below (the last row runs to infinity: D > 60 m is refused before the lookup). */
  readonly fromM: number;
  readonly belowM: number;
  readonly thicknessMm: number;
  readonly grade: SourceGrade;
}

/** Minimum nominal shell thickness by diameter (API 650 5.6.1.1 as quoted by public extracts; edition decision Q6: this table). */
export const TANK_MINIMUM_THICKNESS: readonly MinimumThicknessRow[] = [
  { fromM: 0, belowM: 15, thicknessMm: 5, grade: 'B' },
  { fromM: 15, belowM: 36, thicknessMm: 6, grade: 'B' },
  { fromM: 36, belowM: Infinity, thicknessMm: 8, grade: 'C' },
];

export const TANK_TABLE_EDITION = 'API 650 minimum nominal thickness, public extracts (validation/data/api650_references.json)';

const normalise = (name: string): string => name.toUpperCase().replace(/GRADE|GR|[\s.\-_()]/g, '');

/** Table row of a material designation ("A36M", "A283M Gr C", "A516-70" ...), or undefined. */
export function findTankMaterial(name: string): TankMaterialRow | undefined {
  const key = normalise(name);
  return TANK_MATERIALS.find((row) => row.aliases.includes(key));
}

export function minimumThicknessRow(diameterM: number): MinimumThicknessRow | undefined {
  return TANK_MINIMUM_THICKNESS.find((row) => diameterM >= row.fromM && diameterM < row.belowM);
}
