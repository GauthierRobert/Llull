/** Design step of design_portal_frames that lengthens the eaves haunches before the rafters are up-sized. */
import type { BuildingModel, MomentConnectionElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding, withElement } from '../../building/model';
import type { CheckRow } from './frameCheckSolve';

/** Eaves haunch lengths tried, as fractions of the rafter plan length (0.2 / 0.3 / 0.4 = 10 / 15 / 20 % of the span of a duopitch roof). */
const HAUNCH_STEPS = [0.2, 0.3, 0.4] as const;

/** A haunch trial must cut the summed excess over the target utilisation by at least this fraction to be kept. */
const MIN_EXCESS_GAIN = 0.02;

export interface HaunchTrial {
  readonly building: BuildingModel;
  readonly changes: string[];
  readonly changedIds: string[];
}

const excess = (rows: ReadonlyArray<CheckRow>, target: number): number =>
  rows.filter((row) => row.kind !== 'connection').reduce((sum, row) => sum + Math.max(0, row.utilisation - target), 0);

/**
 * Lengthens the eaves haunches of the rafters in the failing rows to the next step (uniformly for every rafter of those sections) and keeps
 * the change only when `evaluate` (the frame check of a document) shows a lower total excess over `target`; null otherwise (nothing to
 * lengthen, or the haunch does not help). Cost: one frame check per call.
 */
export function tryLongerHaunch(
  doc: CadDocument,
  failing: ReadonlyArray<CheckRow>,
  rows: ReadonlyArray<CheckRow>,
  target: number,
  evaluate: (trial: CadDocument) => ReadonlyArray<CheckRow>,
): HaunchTrial | null {
  const building = getBuilding(doc);
  const profiles = new Set(
    failing.flatMap((row) => {
      const member = building.elements[row.elementId];
      return member?.category === 'member' && member.role === 'rafter' ? [member.profile] : [];
    }),
  );
  if (profiles.size === 0) return null;
  const planLength = (connection: MomentConnectionElement): number => {
    const rafter = building.elements[connection.rafterId];
    return rafter?.category === 'member' ? Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[1] - rafter.start[1]) : 0;
  };
  const eaves = elementsOf(building, 'connection').filter((connection) => {
    const rafter = building.elements[connection.rafterId];
    return connection.kind === 'eaves' && rafter?.category === 'member' && profiles.has(rafter.profile) && planLength(connection) > 0;
  });
  const fractionOf = (connection: MomentConnectionElement): number => connection.haunchLength / planLength(connection);
  if (eaves.length === 0) return null;
  const shortest = Math.min(...eaves.map(fractionOf));
  const step = HAUNCH_STEPS.find((candidate) => candidate > shortest + 0.01);
  if (step === undefined) return null;
  let next = building;
  const changedIds: string[] = [];
  for (const connection of eaves) {
    if (fractionOf(connection) >= step - 0.01) continue;
    next = withElement(next, { ...connection, haunchLength: step * planLength(connection) });
    changedIds.push(connection.id);
  }
  if (changedIds.length === 0) return null;
  const trialRows = evaluate({ ...doc, building: next });
  if (!(excess(trialRows, target) < (1 - MIN_EXCESS_GAIN) * excess(rows, target))) return null;
  const percent = (fraction: number): string => `${Math.round(fraction * 100)}`;
  return {
    building: next,
    changedIds,
    changes: [`eaves haunches ${percent(shortest)} → ${percent(step)} % of the rafter length (${changedIds.length} connection(s))`],
  };
}
