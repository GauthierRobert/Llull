/** Sound-pressure level arithmetic (TR-VAC-10, TR-VAC-12): dB re 20 uPa <-> rms pressure, energy sums. Pure, double precision. */

/** Reference rms sound pressure in air, Pa (reference '20uPa'). */
export const REFERENCE_PRESSURE_PA = 2e-5;

/** Accepted range of a level in dB re 20 uPa: keeps 10^(L/20) finite and rejects absurd input. */
export const LEVEL_DB_MIN = -100;
export const LEVEL_DB_MAX = 300;

/** p = p0 10^(L/20), Pa rms. */
export const splToPressure = (splDb: number): number => REFERENCE_PRESSURE_PA * 10 ** (splDb / 20);

/** L = 20 log10(p / p0), dB re 20 uPa; p > 0. */
export const pressureToSpl = (pRmsPa: number): number => 20 * Math.log10(pRmsPa / REFERENCE_PRESSURE_PA);

/**
 * L = 10 log10 sum 10^(Li/10); the largest level is factored out so large levels never overflow.
 * @invariant levels non-empty (an empty sum is the caller's refusal)
 */
export function energySumDb(levelsDb: readonly number[]): number {
  const peak = Math.max(...levelsDb);
  let sum = 0;
  for (const level of levelsDb) sum += 10 ** ((level - peak) / 10);
  return peak + 10 * Math.log10(sum);
}

/** Overall rms pressure of band levels, Pa: sqrt(sum p_i^2). */
export const overallPressurePa = (levelsDb: readonly number[]): number => splToPressure(energySumDb(levelsDb));
