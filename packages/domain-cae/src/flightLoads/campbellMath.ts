/** Campbell-diagram arithmetic of check_rotor_resonance (14 FLL, TECHNICAL_SPEC §5): excitation k.rpm/60 against a mode frequency, per rpm band. */

/** Excitation frequency of harmonic `harmonic` of a rotor turning at `rpm`, Hz: k . rpm / 60. */
export const excitationHz = (harmonic: number, rpm: number): number => (harmonic * rpm) / 60;

/** Rotor speed at which harmonic `harmonic` equals the mode frequency `frequencyHz`, rpm: 60 . f / k (exact). */
export const crossingRpm = (frequencyHz: number, harmonic: number): number => (60 * frequencyHz) / harmonic;

/** Margin of a mode against the excitation at `rpm`, percent: |f_mode - f_exc| / f_exc x 100; null at rpm 0 (no excitation). */
export function marginPct(frequencyHz: number, harmonic: number, rpm: number): number | null {
  const excitation = excitationHz(harmonic, rpm);
  return excitation > 0 ? (Math.abs(frequencyHz - excitation) / excitation) * 100 : null;
}

export interface BandMargin {
  /** Rotor speed inside the band where the harmonic equals the mode, rpm; null when the mode is not crossed in the band. */
  readonly crossingRpm: number | null;
  /** Smallest margin over the band, percent: 0 at a crossing, else at the band edge nearer to the crossing speed. */
  readonly minMarginPct: number;
  /** Rotor speed of that smallest margin, rpm. */
  readonly atRpm: number;
}

/**
 * Smallest margin of mode `frequencyHz` against harmonic `harmonic` over the rpm band [low, high] (0 <= low <= high, high > 0, frequencyHz > 0).
 * @invariant the margin is monotone on each side of the crossing, so the minimum is 0 at an interior crossing, else at the nearest band edge
 */
export function bandMargin(frequencyHz: number, harmonic: number, low: number, high: number): BandMargin {
  const crossing = crossingRpm(frequencyHz, harmonic);
  if (crossing >= low && crossing <= high && crossing > 0) return { crossingRpm: crossing, minMarginPct: 0, atRpm: crossing };
  const edge = crossing < low ? low : high;
  return { crossingRpm: null, minMarginPct: marginPct(frequencyHz, harmonic, edge) ?? Number.POSITIVE_INFINITY, atRpm: edge };
}
