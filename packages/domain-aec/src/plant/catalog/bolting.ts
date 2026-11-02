/**
 * Bolted-joint rules (plant 01 PSC M4, decision Q3): raised-face height, thread pitch and the named stud-length rule
 * `L = ceil((t1 + RF1 + t2 + RF2 + g + 2 n + 2 p) / step) x step`, with t flange thicknesses (the catalogue value excludes the raised face), RF raised-face heights,
 * g the gasket, n a nut height, p the thread projection beyond the nut (two pitches) and step the stocking increment. Every constant is named and
 * returned with the result; a stud length from the rule is DERIVED and never verified. An imported bolting table (`studLength`) overrides it.
 * @invariant pure; the rule returns null (never a guess) when an input it needs is unknown
 */

export const MM_PER_INCH = 25.4;
/** Stud lengths are stocked and ordered in quarter inches. */
export const STUD_STEP_MM = 6.35;
/** Thread projection beyond each nut, in thread pitches (two full threads). */
export const PROJECTION_PITCHES = 2;

/** ASME B1.1 thread pitch (mm) by nominal bolt diameter in inches: UNC to 1 in, 8-UN from 1-1/8 in (the B16.5 / B16.47 bolting series). */
const INCH_PITCH_TPI: ReadonlyArray<readonly [inches: number, threadsPerInch: number]> = [
  [0.5, 13],
  [0.625, 11],
  [0.75, 10],
  [0.875, 9],
  [1, 8],
  [1.125, 8],
  [1.25, 8],
  [1.375, 8],
  [1.5, 8],
  [1.625, 8],
  [1.75, 8],
  [1.875, 8],
  [2, 8],
  [2.25, 8],
  [2.5, 8],
  [2.75, 8],
  [3, 8],
];

/** ISO 261 coarse pitch (mm) by nominal diameter (mm). */
const METRIC_PITCH_MM: ReadonlyArray<readonly [diameter: number, pitch: number]> = [
  [10, 1.5],
  [12, 1.75],
  [16, 2],
  [20, 2.5],
  [22, 2.5],
  [24, 3],
  [27, 3],
  [30, 3.5],
  [33, 3.5],
  [36, 4],
  [39, 4],
  [42, 4.5],
  [45, 4.5],
  [48, 5],
];

const MATCH_TOLERANCE_MM = 0.05;

/** Thread pitch in mm of a bolt of nominal diameter `diameterMm` (inch series first, then ISO coarse), or null when the size is not tabulated. */
export function threadPitchMm(diameterMm: number): number | null {
  const inch = INCH_PITCH_TPI.find(([inches]) => Math.abs(inches * MM_PER_INCH - diameterMm) <= MATCH_TOLERANCE_MM);
  if (inch !== undefined) return MM_PER_INCH / inch[1];
  return METRIC_PITCH_MM.find(([diameter]) => Math.abs(diameter - diameterMm) <= MATCH_TOLERANCE_MM)?.[1] ?? null;
}

/**
 * Raised-face height (mm) of an ASME B16.5 flange: 1.6 mm (1/16 in) for Class 150 and 300, 6.4 mm (1/4 in) from Class 400; 0 for a flat face; null for any
 * other facing, class or standard (not tabulated here: RTJ, tongue-and-groove, EN 1092-1 faces).
 */
export function raisedFaceHeightMm(standard: string, ratingClass: number | undefined, facing: string | undefined): number | null {
  if (!/B16\.5/.test(standard) || ratingClass === undefined) return null;
  if (facing === 'FF') return 0;
  if (facing !== 'RF') return null;
  if (ratingClass === 150 || ratingClass === 300) return 1.6;
  return ratingClass >= 400 ? 6.4 : null;
}

export interface StudInputs {
  readonly flangeThicknessAMm: number;
  readonly flangeThicknessBMm: number;
  readonly raisedFaceAMm: number;
  readonly raisedFaceBMm: number;
  readonly gasketMm: number;
  readonly boltDiameterMm: number;
  /** Nut height; the nominal bolt diameter when absent (heavy hex nuts are 0.85 to 0.9 d, so d is the safe side). */
  readonly nutHeightMm?: number | undefined;
}

export interface StudLength {
  readonly lengthMm: number;
  readonly exactMm: number;
  readonly gripMm: number;
  readonly nutHeightMm: number;
  readonly projectionMm: number;
  readonly pitchMm: number;
  readonly stepMm: number;
  readonly formula: string;
}

/** The stud length of a flanged joint by the named rule, or null when the thread pitch of the bolt is not tabulated or an input is not a positive/finite length. */
export function studLengthRule(input: StudInputs): StudLength | null {
  const pitch = threadPitchMm(input.boltDiameterMm);
  const lengths = [input.flangeThicknessAMm, input.flangeThicknessBMm, input.gasketMm, input.boltDiameterMm];
  if (
    pitch === null ||
    !lengths.every((value) => Number.isFinite(value) && value > 0) ||
    input.raisedFaceAMm < 0 ||
    input.raisedFaceBMm < 0
  )
    return null;
  const nut = input.nutHeightMm ?? input.boltDiameterMm;
  if (!(nut > 0) || !Number.isFinite(nut)) return null;
  const grip = input.flangeThicknessAMm + input.raisedFaceAMm + input.flangeThicknessBMm + input.raisedFaceBMm + input.gasketMm;
  const projection = PROJECTION_PITCHES * pitch;
  const exact = grip + 2 * nut + 2 * projection;
  return {
    lengthMm: Math.round(Math.ceil(exact / STUD_STEP_MM - 1e-9) * STUD_STEP_MM * 1e4) / 1e4,
    exactMm: exact,
    gripMm: grip,
    nutHeightMm: nut,
    projectionMm: projection,
    pitchMm: pitch,
    stepMm: STUD_STEP_MM,
    formula: 'L = ceil((t1 + RF1 + t2 + RF2 + g + 2 nut + 2 x 2 pitch) / 6.35) x 6.35 mm',
  };
}

/** Quarter-inch text of a length in mm (`"3-3/4"`), or null when it is not a multiple of 1/4 in. */
export function quarterInchText(mm: number): string | null {
  const quarters = mm / STUD_STEP_MM;
  if (Math.abs(quarters - Math.round(quarters)) > 1e-3) return null;
  const whole = Math.floor(Math.round(quarters) / 4);
  const rest = Math.round(quarters) - whole * 4;
  const fraction = rest === 0 ? '' : rest === 2 ? '1/2' : `${rest}/4`;
  return fraction === '' ? String(whole) : whole === 0 ? fraction : `${whole}-${fraction}`;
}

/** Gasket thicknesses (mm) assumed when a gasket row has none: ASME B16.20 spiral wound 4.5 mm nominal, sheet 1/16 in; a ring joint has none to assume. */
export const ASSUMED_GASKET_MM: Readonly<Record<string, number>> = { gasketSpiralWound: 4.5, gasketSheet: 1.6 };
