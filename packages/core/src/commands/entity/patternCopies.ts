import type { CadDocument, Entity } from '../../model/types';

/**
 * Pattern copies of `seedIds` that still follow their seed on `field` (same value as their own seed before the edit), transitively:
 * a copy of a copy is reached only through a copy that follows. In document order, seeds excluded.
 * @invariant follows `patternSourceId` links only; a copy that diverged (and its own copies) is never listed
 */
export function patternFollowers(
  doc: CadDocument,
  seedIds: readonly string[],
  field: keyof Pick<Entity, 'materialId' | 'color'>,
): string[] {
  const copiesOf = new Map<string, string[]>();
  for (const id of doc.order) {
    const source = doc.entities[id]?.patternSourceId;
    if (source !== undefined) copiesOf.set(source, [...(copiesOf.get(source) ?? []), id]);
  }
  const reached = new Set(seedIds);
  const followers: string[] = [];
  const queue = [...seedIds];
  for (let seedId = queue.shift(); seedId !== undefined; seedId = queue.shift()) {
    const seed = doc.entities[seedId];
    for (const id of copiesOf.get(seedId) ?? []) {
      if (reached.has(id) || doc.entities[id]?.[field] !== seed?.[field]) continue;
      reached.add(id);
      followers.push(id);
      queue.push(id);
    }
  }
  const position = new Map(doc.order.map((id, index) => [id, index]));
  return followers.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
}
