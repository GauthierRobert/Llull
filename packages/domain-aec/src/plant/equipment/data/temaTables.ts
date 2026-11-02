/**
 * TEMA designation letters and BWG tube walls as data (plant 03 EQP §5.7). The TEMA standard is paywalled: letters are those tabulated by ht 1.2.0
 * (hx.py, citing TEMA 9th ed. 2007) and cross-checked with public extracts (validation/data/tema_designations.json, grade A); BWG walls are one
 * secondary tabulation (grade B, so a tube wall taken from them is `unverified`).
 */

import type { SourceGrade } from '../model';

export type TemaPart = 'front' | 'shell' | 'rear';

export const TEMA_LETTERS: Readonly<Record<TemaPart, Readonly<Record<string, string>>>> = {
  front: {
    A: 'Removable Channel and Cover',
    B: 'Bonnet (Integral Cover)',
    C: 'Integral With Tubesheet, Removable Cover',
    N: 'Channel Integral With Tubesheet and Removable Cover',
    D: 'Special High-Pressure Closure',
  },
  shell: {
    E: 'One-Pass Shell',
    F: 'Two-Pass Shell with Longitudinal Baffle',
    G: 'Split Flow',
    H: 'Double Split Flow',
    J: 'Divided Flow',
    K: 'Kettle-Type Reboiler',
    X: 'Cross Flow',
  },
  rear: {
    L: 'Fixed Tubesheet, Like "A" Stationary Head',
    M: 'Fixed Tubesheet, Like "B" Stationary Head',
    N: 'Fixed Tubesheet, Like "C" Stationary Head',
    P: 'Outside Packed Floating Head',
    S: 'Floating Head with Backing Device',
    T: 'Pull-Through Floating Head',
    U: 'U-Tube Bundle',
    W: 'Externally Sealed Floating Tubesheet',
  },
};

/** Valid TEMA letters that llull does not model yet (`EQP_TEMA_UNSUPPORTED`). */
export const TEMA_UNSUPPORTED: Readonly<Record<TemaPart, readonly string[]>> = { front: ['D'], shell: ['K', 'X'], rear: [] };

/** Rear heads with a tubesheet at each end of the shell (bundle not removable). */
export const TEMA_FIXED_REARS: readonly string[] = ['L', 'M', 'N'];

export const TEMA_SOURCE = 'TEMA 9th ed. 2007 designation letters via ht 1.2.0 hx.py (validation/data/tema_designations.json, grade A)';

export interface TubeWallRow {
  readonly outsideDiameterMm: number;
  readonly bwg: number;
  readonly wallMm: number;
  readonly grade: SourceGrade;
}

export const TUBE_WALLS: readonly TubeWallRow[] = [0.75, 1].flatMap((inches) =>
  (
    [
      [12, 2.769],
      [14, 2.108],
      [16, 1.651],
      [18, 1.245],
    ] as const
  ).map(([bwg, wallMm]): TubeWallRow => ({ outsideDiameterMm: Math.round(inches * 25.4 * 100) / 100, bwg, wallMm, grade: 'B' })),
);

export const TUBE_WALL_SOURCE =
  'BWG wall table via ht 1.2.0 (engineeringpage.com), validation/data/tema_designations.json tubeSizes, grade B';

/** Row of tube outside diameter `outsideDiameterMm` (within 0.01 mm) and gauge `bwg`, or undefined. */
export const tubeWallRow = (outsideDiameterMm: number, bwg: number): TubeWallRow | undefined =>
  TUBE_WALLS.find((row) => row.bwg === bwg && Math.abs(row.outsideDiameterMm - outsideDiameterMm) <= 0.01);
