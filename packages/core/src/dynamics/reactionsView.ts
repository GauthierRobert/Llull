// The `reactions` block of a simulate_motion run (series mode) as typed series, shared by the review timeline and the loads list.

import type { SimulationData } from './simulationReport';
import { isRecord } from '../lib/isRecord';

export interface ReactionsView {
  readonly times: readonly number[];
  /** Force on the child body at the joint anchor, world axes, N, per sample. */
  readonly forces: Readonly<Record<string, readonly (readonly [number, number, number])[]>>;
  readonly peaks: Readonly<Record<string, { readonly value: number; readonly timeS: number }>>;
}

const isVec3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number');

/** The `reactions` block of a simulate_motion run (series mode), or null. */
export function reactionsOf(result: SimulationData | null): ReactionsView | null {
  const reactions = isRecord(result) ? (result as unknown as Record<string, unknown>)['reactions'] : undefined;
  if (!isRecord(reactions)) return null;
  const peaks: Record<string, { value: number; timeS: number }> = {};
  for (const [joint, entry] of Object.entries(isRecord(reactions['joints']) ? reactions['joints'] : {})) {
    const force = isRecord(entry) && isRecord(entry['forceN']) ? entry['forceN'] : null;
    if (force !== null && typeof force['value'] === 'number' && typeof force['timeS'] === 'number')
      peaks[joint] = { value: force['value'], timeS: force['timeS'] };
  }
  const series = isRecord(reactions['series']) ? reactions['series'] : null;
  const times = series !== null && Array.isArray(series['times']) ? series['times'].filter((t): t is number => typeof t === 'number') : [];
  const forces: Record<string, (readonly [number, number, number])[]> = {};
  for (const [joint, entry] of Object.entries(series !== null && isRecord(series['joints']) ? series['joints'] : {}))
    if (isRecord(entry) && Array.isArray(entry['force'])) forces[joint] = entry['force'].filter(isVec3);
  return { times, forces, peaks };
}
