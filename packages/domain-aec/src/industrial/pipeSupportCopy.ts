/**
 * Pipe supports follow their pipe when a level is copied: each copied pipe gets copies of its
 * supports, re-attached to the copied steel member (unattached when that member was not copied).
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel } from '@core/model/building';
import { elementsOf, nextElementId, nextMark, withElement } from '../model';

/** Copies the supports of every pipe in `copiedIds` (source id → copy id) onto `levelId`. */
export function copyPipeSupports(
  source: BuildingModel,
  target: BuildingModel,
  copiedIds: ReadonlyMap<string, string>,
  levelId: string,
): { building: BuildingModel; ids: string[] } {
  let building = target;
  const ids: string[] = [];
  for (const support of elementsOf(source, 'pipeSupport')) {
    const pipeId = copiedIds.get(support.pipeId);
    if (pipeId === undefined) continue;
    const memberId = support.memberId === null ? undefined : copiedIds.get(support.memberId);
    const copyId = nextElementId(building, 'pipeSupport');
    building = withElement(building, {
      ...support,
      id: copyId,
      mark: nextMark(building, 'pipeSupport'),
      levelId,
      pipeId,
      memberId: memberId ?? null,
      ...(memberId === undefined ? { rodLength: 0 } : {}),
      entityIds: [],
    });
    ids.push(copyId);
  }
  return { building, ids };
}
