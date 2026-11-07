/** Base-10 octave / third-octave band system of IEC 61260-1 (TR-VAC-11): G = 10^0.3, f_r = 1000 Hz, nominal label -> exact frequencies by table lookup. */

export type Bandwidth = 'octave' | 'third_octave';

/** Nominal labels, Hz; the index is x + offset (x = band number from 1 kHz). */
export const THIRD_OCTAVE_NOMINAL_HZ: readonly number[] = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
  10000, 12500, 16000, 20000,
];
export const OCTAVE_NOMINAL_HZ: readonly number[] = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Band number x of the 25 Hz third and of the 31.5 Hz octave. */
const THIRD_FIRST_X = -16;
const OCTAVE_FIRST_X = -5;

const FRACTION: Readonly<Record<Bandwidth, number>> = { octave: 1, third_octave: 3 };

export interface BandGeometry {
  /** Band number from 1 kHz (x = 0). */
  readonly x: number;
  readonly nominalHz: number;
  readonly exactMidHz: number;
  readonly lowerHz: number;
  readonly upperHz: number;
  readonly bandwidthHz: number;
}

const nominalTable = (bandwidth: Bandwidth): readonly number[] => (bandwidth === 'octave' ? OCTAVE_NOMINAL_HZ : THIRD_OCTAVE_NOMINAL_HZ);
const firstX = (bandwidth: Bandwidth): number => (bandwidth === 'octave' ? OCTAVE_FIRST_X : THIRD_FIRST_X);

/** Exact geometry of band `x` (odd b): f_m = 1000 G^(x/b), f1,2 = f_m G^(-/+ 1/(2b)), G^t = 10^(0.3 t). */
function geometryOf(bandwidth: Bandwidth, x: number, nominalHz: number): BandGeometry {
  const b = FRACTION[bandwidth];
  const exactMidHz = 1000 * 10 ** ((3 * x) / (10 * b));
  const lowerHz = exactMidHz * 10 ** (-3 / (20 * b));
  const upperHz = exactMidHz * 10 ** (3 / (20 * b));
  return { x, nominalHz, exactMidHz, lowerHz, upperHz, bandwidthHz: upperHz - lowerHz };
}

/** The band with nominal label `nominalHz`, or undefined when the label is not in the table (never by rounding). */
export function bandByNominal(bandwidth: Bandwidth, nominalHz: number): BandGeometry | undefined {
  const index = nominalTable(bandwidth).indexOf(nominalHz);
  return index < 0 ? undefined : geometryOf(bandwidth, firstX(bandwidth) + index, nominalHz);
}

/** The band numbered `x`, or undefined when outside the nominal table. */
export function bandByNumber(bandwidth: Bandwidth, x: number): BandGeometry | undefined {
  const nominalHz = nominalTable(bandwidth)[x - firstX(bandwidth)];
  return nominalHz === undefined ? undefined : geometryOf(bandwidth, x, nominalHz);
}

/** Octave number containing third-octave band x: thirds 3k-1, 3k, 3k+1 make octave k (edges coincide). */
export const octaveOfThird = (thirdX: number): number => Math.floor((thirdX + 1) / 3);
