/** `*AMPLITUDE` blocks of the thermal BCs that use one (shared by the heat_transient and the transient coupled deck). */

import type { ThermalSetup } from '@core/model/analysis';
import { row } from '../decks/format';
import { amplitudeName } from './deckNames';

/** One `*AMPLITUDE, NAME=` block (rows of four time, factor pairs per line) per amplitude a BC refers to, sorted by id. */
export function amplitudeLines(thermal: ThermalSetup): string[] {
  const lines: string[] = [];
  const used = [...new Set(thermal.bcOrder.map((id) => thermal.bcs[id]?.amplitude).filter((id): id is string => id !== undefined))].sort();
  for (const id of used) {
    const points = thermal.amplitudes[id]?.points ?? [];
    lines.push(`*AMPLITUDE, NAME=${amplitudeName(id)}`);
    for (let i = 0; i < points.length; i += 4) lines.push(row(...points.slice(i, i + 4).flat()));
  }
  return lines;
}
