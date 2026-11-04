/**
 * ASME A13.1 marker legend size (plant 09 VIS §5.7, TR-VIS-04): the field length and letter height of a pipe-content marker by the outside diameter of the pipe or its covering.
 * Rows are the vendor tables of `validation/data/service_colour_schemes.json` (`asme_a13_1_legend_size`, grade A except the field length of the smallest row).
 * An OD between two rows takes the next larger row and says so (`bandInterpolated`); an OD under the first row takes the first row, likewise.
 * @invariant pure; field length and letter height in mm (inches x 25.4, 3 decimals)
 */

export interface Legend {
  readonly row: string;
  readonly fieldLengthMm: number;
  readonly letterHeightMm: number;
  readonly bandInterpolated: boolean;
}

interface LegendRow {
  readonly label: string;
  readonly minIn: number;
  /** The first row above this one is exclusive at its lower bound (10 in belongs to the 8-10 row). */
  readonly maxIn: number;
  readonly exclusiveMin?: boolean;
  readonly fieldIn: number;
  readonly letterIn: number;
}

const ROWS: readonly LegendRow[] = [
  { label: '0.75-1.25', minIn: 0.75, maxIn: 1.25, fieldIn: 8, letterIn: 0.5 },
  { label: '1.5-2', minIn: 1.5, maxIn: 2, fieldIn: 8, letterIn: 0.75 },
  { label: '2.5-6', minIn: 2.5, maxIn: 6, fieldIn: 12, letterIn: 1.25 },
  { label: '8-10', minIn: 8, maxIn: 10, fieldIn: 24, letterIn: 2.5 },
  { label: '>10', minIn: 10, maxIn: Number.POSITIVE_INFINITY, exclusiveMin: true, fieldIn: 32, letterIn: 3.5 },
];

const MM_PER_IN = 25.4;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Legend of a pipe of outside diameter `odMm` with `insulationMm` of covering each side (0 = bare). */
export function legendFor(odMm: number, insulationMm: number): Legend {
  const odIn = (odMm + 2 * insulationMm) / MM_PER_IN;
  const exact = ROWS.find((row) => (row.exclusiveMin === true ? odIn > row.minIn : odIn >= row.minIn) && odIn <= row.maxIn);
  const row = exact ?? ROWS.find((candidate) => candidate.minIn > odIn) ?? (ROWS.at(-1) as LegendRow);
  return {
    row: row.label,
    fieldLengthMm: round3(row.fieldIn * MM_PER_IN),
    letterHeightMm: round3(row.letterIn * MM_PER_IN),
    bandInterpolated: exact === undefined,
  };
}
