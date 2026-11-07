/** Third-octave -> octave regrouping (TR-VAC-14): energy sum of the three thirds of each octave; incomplete octaves are omitted and listed. */

import { bandByNominal, bandByNumber, octaveOfThird } from './bands';
import { energySumDb } from './levels';

export interface NominalLevel {
  readonly nominalHz: number;
  readonly splDb: number;
}

export interface Regrouped {
  readonly octaves: readonly NominalLevel[];
  /** Nominal labels (Hz) of octaves with fewer than three thirds present. */
  readonly omittedOctavesHz: readonly number[];
}

/** `thirds` are bands with labels in the third-octave table; unknown labels are ignored (the command validated them). */
export function regroupThirdsToOctaves(thirds: readonly NominalLevel[]): Regrouped {
  const groups = new Map<number, number[]>();
  for (const third of thirds) {
    const band = bandByNominal('third_octave', third.nominalHz);
    if (band === undefined) continue;
    const octave = octaveOfThird(band.x);
    groups.set(octave, [...(groups.get(octave) ?? []), third.splDb]);
  }
  const octaves: NominalLevel[] = [];
  const omittedOctavesHz: number[] = [];
  for (const octave of [...groups.keys()].sort((a, b) => a - b)) {
    const levels = groups.get(octave) ?? [];
    const nominalHz = bandByNumber('octave', octave)?.nominalHz;
    if (nominalHz === undefined) continue;
    if (levels.length === 3) octaves.push({ nominalHz, splDb: energySumDb(levels) });
    else omittedOctavesHz.push(nominalHz);
  }
  return { octaves, omittedOctavesHz };
}
