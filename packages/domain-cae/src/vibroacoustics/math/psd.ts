/** Band-averaged one-sided pressure PSD (TR-VAC-13): G = p^2 / (f2 - f1), Pa^2/Hz, and its exact inverse. */

import { REFERENCE_PRESSURE_PA, splToPressure } from './levels';

/** Band-averaged PSD of a band at `splDb` between `lowerHz` and `upperHz`. */
export const bandPsd = (splDb: number, lowerHz: number, upperHz: number): number => splToPressure(splDb) ** 2 / (upperHz - lowerHz);

/** Band level (dB re 20 uPa) of a band-averaged PSD: 10 log10(G (f2 - f1)) - 20 log10(p0). */
export const bandSplFromPsd = (psdPa2PerHz: number, lowerHz: number, upperHz: number): number =>
  10 * Math.log10(psdPa2PerHz * (upperHz - lowerHz)) - 20 * Math.log10(REFERENCE_PRESSURE_PA);
