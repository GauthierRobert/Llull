import type { CadDocument, Entity } from '../../model/types';
import { replaceEntities } from './entityOps';

const renameKeys = <T>(record: Readonly<Record<string, T>>, swap: (id: string) => string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [swap(key), value]));

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * `doc` with the entities `fromIds` moved into a container (e.g. a component) and `stand` put in their place: everything that referenced
 * one of them now references `stand.id` (group members, selection, animation targets, material class, import provenance, patternSourceId
 * of copies). Only constraints / joints / drive relations naming a sub-shape are pruned (counted by `referenceLossSuffix`). A group whose
 * members all collapse into `stand` is dissolved (named in `dissolvedGroups`) and its animations retarget `stand`.
 * @invariant relocating an entity is not deleting it: one source keeps its groups, selection, animations, class and provenance
 */
export function relocateEntities(
  doc: CadDocument,
  fromIds: readonly string[],
  stand: Entity,
): { readonly document: CadDocument; readonly dissolvedGroups: string[] } {
  const moved = new Set(fromIds);
  const swap = (id: string): string => (moved.has(id) ? stand.id : id);
  const display = doc.display;
  const classes = display?.materialClassOf;
  const provenance = doc.exchange?.provenance;
  const dissolvedGroups: string[] = [];
  const groups: CadDocument['groups'] = {};
  for (const [id, group] of Object.entries(doc.groups)) {
    const memberIds = unique(group.memberIds.map(swap));
    if (memberIds.length >= 2 || memberIds.length === group.memberIds.length) groups[id] = { ...group, memberIds };
    else dissolvedGroups.push(id);
  }
  const retarget = (targetId: string): string => (dissolvedGroups.includes(targetId) ? stand.id : swap(targetId));
  const remapped: CadDocument = {
    ...doc,
    entities: Object.fromEntries(
      Object.entries(doc.entities).map(([id, entity]) => [
        id,
        entity.patternSourceId !== undefined && moved.has(entity.patternSourceId) ? { ...entity, patternSourceId: stand.id } : entity,
      ]),
    ),
    selection: unique(doc.selection.map(swap)),
    groups,
    animations: Object.fromEntries(
      Object.entries(doc.animations).map(([id, animation]) => [id, { ...animation, targetId: retarget(animation.targetId) }]),
    ),
    ...(display === undefined || classes === undefined || !fromIds.some((id) => id in classes)
      ? {}
      : { display: { ...display, materialClassOf: renameKeys(classes, swap) } }),
    ...(provenance === undefined || doc.exchange === undefined || !fromIds.some((id) => id in provenance)
      ? {}
      : { exchange: { ...doc.exchange, provenance: renameKeys(provenance, swap) } }),
  };
  return { document: replaceEntities(remapped, [...fromIds], stand), dissolvedGroups };
}
