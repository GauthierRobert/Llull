/** Product structure (09 PLM FR-PLM-23/24): the EBOM of the assembly from its bound sub-items, and the baseline member sets compared against it. */

import type { CadDocument } from '@core/model/types';
import type { BaselineMember, PlmModel, Revision, StructureRow } from '@core/model/plm';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { currentRevisionOf } from './state';

const FROZEN = new Set(['released', 'superseded', 'obsolete']);

/** Instances of each component placed directly in the document (level 1 of this definition). */
function instanceCounts(doc: CadDocument): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entity of Object.values(doc.entities)) {
    if (entity.kind === 'instance') counts.set(entity.componentId, (counts.get(entity.componentId) ?? 0) + 1);
  }
  return counts;
}

/** Level-1 rows of the live structure: every bound sub-item with its instance count, sorted by part number. */
export function liveStructure(doc: CadDocument, plm: PlmModel): StructureRow[] {
  const counts = instanceCounts(doc);
  return Object.values(plm.subItems ?? {})
    .sort((a, b) => (a.partNumber < b.partNumber ? -1 : a.partNumber > b.partNumber ? 1 : 0))
    .map((sub) => ({
      partNumber: sub.partNumber,
      revision: sub.revision,
      state: sub.state,
      quantity: counts.get(sub.componentId) ?? 0,
      ...(sub.contentHash !== undefined ? { contentHash: sub.contentHash } : {}),
    }));
}

/** Components of the document that carry instances but no bound sub-item: parts the EBOM does not cover. */
export function unmanagedComponents(doc: CadDocument, plm: PlmModel): { componentId: string; name: string; quantity: number }[] {
  const bound = new Set(Object.values(plm.subItems ?? {}).map((sub) => sub.componentId));
  return [...instanceCounts(doc)]
    .filter(([componentId]) => !bound.has(componentId))
    .map(([componentId, quantity]) => ({ componentId, name: doc.components[componentId]?.name ?? '(missing)', quantity }))
    .sort((a, b) => (a.componentId < b.componentId ? -1 : 1));
}

/** Sub-items that are not released (released is required to release the assembly). */
export const unreleasedChildren = (plm: PlmModel): string[] =>
  Object.values(plm.subItems ?? {})
    .filter((sub) => sub.state !== 'released')
    .map((sub) => sub.partNumber)
    .sort();

/** The last revision of the item that is released (the current one when it is, else the newest released / superseded one), or undefined. */
export function baselineRoot(plm: PlmModel): Revision | undefined {
  const current = currentRevisionOf(plm);
  if (current?.state === 'released') return current;
  return [...plm.item.revisionOrder]
    .reverse()
    .map((label) => plm.item.revisions[label])
    .find((revision) => revision !== undefined && (revision.state === 'released' || revision.state === 'superseded'));
}

/** The canonical hash of a member list (sorted by part number): what `Baseline.hash` records. */
export const membersHash = (members: readonly BaselineMember[]): string => sha256Hex(jcsJson(members));

export const isFrozenState = (state: string): boolean => FROZEN.has(state);

export interface WorkingMember extends BaselineMember {
  readonly state: string;
}

/** The structure as it is now: the item at its current revision plus every bound sub-item (a revision without a hash reads its last iteration hash). */
export function workingMembers(plm: PlmModel): WorkingMember[] {
  const revision = currentRevisionOf(plm);
  const root: WorkingMember[] =
    revision === undefined
      ? []
      : [
          {
            partNumber: plm.item.partNumber,
            revision: revision.label,
            contentHash: revision.contentHash ?? revision.iterations.at(-1)?.contentHash ?? '',
            state: revision.state,
          },
        ];
  const subs = Object.values(plm.subItems ?? {}).map((sub) => ({
    partNumber: sub.partNumber,
    revision: sub.revision,
    contentHash: sub.contentHash ?? '',
    state: sub.state,
  }));
  return [...root, ...subs].sort((a, b) => (a.partNumber < b.partNumber ? -1 : a.partNumber > b.partNumber ? 1 : 0));
}
