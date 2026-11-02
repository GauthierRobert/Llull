/**
 * Centrifugal pump envelope rows (plant 03 EQP §5.8): ISO 2858 (a, f, h1, h2) and ASME B73.1 (CP, D, X). Both standards are paywalled: rows are
 * transcribed from manufacturer catalogues as quoted by public extracts (validation/data/pump_envelopes.json); a row is grade A only where two
 * independent catalogues agree. Dimensions in mm (B73.1 in inches there, converted here). Dimension meanings are open question Q4.
 */

import type { SourceGrade } from '../model';

export interface IsoPumpRow {
  readonly size: string;
  /** Suction flange face to the discharge nozzle centre; null = not legible in the sources (the row cannot be used). */
  readonly aMm: number | null;
  readonly fMm: number | null;
  readonly h1Mm: number;
  readonly h2Mm: number;
  readonly grade: SourceGrade;
  readonly sources: readonly string[];
}

export const ISO_2858_ROWS: readonly IsoPumpRow[] = [
  { size: '50-32-125', aMm: null, fMm: null, h1Mm: 112, h2Mm: 140, grade: 'B', sources: ['IS 13518 scan (garbled)'] },
  {
    size: '50-32-160',
    aMm: 80,
    fMm: 385,
    h1Mm: 132,
    h2Mm: 160,
    grade: 'A',
    sources: ['smartwater ISOPRO', 'IS 13518 / ISO 2858 reproductions'],
  },
  { size: '50-32-200', aMm: 80, fMm: 385, h1Mm: 160, h2Mm: 180, grade: 'A', sources: ['smartwater ISOPRO', 'Northridge XCP 32-200'] },
  {
    size: '65-40-250',
    aMm: 100,
    fMm: 500,
    h1Mm: 180,
    h2Mm: 225,
    grade: 'A',
    sources: ['smartwater ISOPRO', 'Goulds IC', 'Northridge XCP 40-250', 'Standartpompa EN 733 40-250'],
  },
  {
    size: '80-50-200',
    aMm: 100,
    fMm: 385,
    h1Mm: 160,
    h2Mm: 200,
    grade: 'A',
    sources: ['smartwater ISOPRO', 'Standard Pumps SEL / Apec Milano'],
  },
];

export interface B731PumpRow {
  readonly designation: string;
  /** Suction x discharge size in inches, then impeller (e.g. `1.5x1-6`). */
  readonly size: string;
  readonly cpMm: number;
  readonly dMm: number;
  readonly xMm: number;
  readonly grade: SourceGrade;
  readonly sources: readonly string[];
}

const inch = (value: number): number => Math.round(value * 25.4 * 1000) / 1000;

/** CP and D are grade B (one dimension sheet); only X of row AA is confirmed by a second source, so every row is B as a whole. */
export const B73_1_ROWS: readonly B731PumpRow[] = [
  {
    designation: 'AA',
    size: '1.5x1-6',
    cpMm: inch(17.5),
    dMm: inch(5.25),
    xMm: inch(6.5),
    grade: 'B',
    sources: ['BaseTek dimension sheet (B73.1M-1991)', 'OnHandSupply (X)'],
  },
  {
    designation: 'AB',
    size: '3x1.5-6',
    cpMm: inch(17.5),
    dMm: inch(5.25),
    xMm: inch(6.5),
    grade: 'B',
    sources: ['BaseTek dimension sheet'],
  },
  {
    designation: 'A05',
    size: '2x1-10',
    cpMm: inch(23.5),
    dMm: inch(8.25),
    xMm: inch(8.5),
    grade: 'B',
    sources: ['BaseTek dimension sheet'],
  },
  {
    designation: 'A60',
    size: '3x2-10',
    cpMm: inch(23.5),
    dMm: inch(8.25),
    xMm: inch(9.5),
    grade: 'B',
    sources: ['BaseTek dimension sheet'],
  },
];

export const PUMP_TABLE_SOURCE = 'public catalogue extracts (validation/data/pump_envelopes.json)';

const compact = (text: string): string => text.replace(/\s+/g, '').toUpperCase();

export const isoPumpRow = (size: string): IsoPumpRow | undefined => ISO_2858_ROWS.find((row) => row.size === compact(size));

/** Row by B73.1 dimension designation (`AA`) or by size text (`1.5x1-6`). */
export const b731PumpRow = (key: string): B731PumpRow | undefined =>
  B73_1_ROWS.find((row) => row.designation === compact(key) || row.size.toUpperCase() === compact(key));
