/**
 * Drainage design criteria and rainfall intensity (constant or IDF curve i = a / (t + b)^c).
 * @layer domain-aec/civil
 * @pure
 */

/** Intensity-duration-frequency curve: i (mm/h) = a / (t + b)^c, t in minutes. */
export interface Idf {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface DrainageCriteria {
  readonly rainfallIntensityMmH: number;
  readonly idf: Idf | null;
  readonly minVelocity: number;
  readonly maxVelocity: number;
  readonly minCoverM: number;
  readonly maxDepthRatio: number;
  readonly manholeLossK: number;
  readonly freeboardM: number;
  /** Tailwater elevation at the outfall(s), document units; null = outlet pipe normal depth. */
  readonly outfallLevel: number | null;
}

export const DEFAULT_CRITERIA: DrainageCriteria = {
  rainfallIntensityMmH: 50,
  idf: null,
  minVelocity: 0.6,
  maxVelocity: 3,
  minCoverM: 0.9,
  maxDepthRatio: 0.8,
  manholeLossK: 0.5,
  freeboardM: 0.3,
  outfallLevel: null,
};

/** Inlet time (minutes) of a manhole without `entryTimeMin`. */
export const DEFAULT_ENTRY_TIME_MIN = 5;

/** Rainfall intensity (mm/h) for a time of concentration of `tcMin` minutes. */
export function intensityAt(criteria: DrainageCriteria, tcMin: number): number {
  const idf = criteria.idf;
  return idf ? idf.a / (tcMin + idf.b) ** idf.c : criteria.rainfallIntensityMmH;
}

/** Error text when an IDF curve is unusable, else null. */
export function idfError(idf: Idf): string | null {
  if (!(idf.a > 0) || !(idf.b >= 0) || !(idf.c > 0)) {
    return 'idf needs a > 0, b >= 0 and c > 0.';
  }
  return null;
}
