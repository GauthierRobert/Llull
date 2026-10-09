/**
 * Civil model access: id minting, object insert / remove, typed lookups and `affected` lists.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument, DocumentUnit } from '@core/model/types';
import type { CivilCategory, CivilModel, CivilObject } from '@core/model/civil';
import { createEmptyCivil } from '@core/model/civil';
import { fromMm, toMetres } from '../model';

export function getCivil(doc: Pick<CadDocument, 'civil'>): CivilModel {
  return doc.civil ?? createEmptyCivil();
}

/** Readable object id never issued before in this model, e.g. "surface-2". */
export function nextCivilId(civil: CivilModel, category: CivilCategory): string {
  let highest = civil.counters[category] ?? 0;
  for (const id of Object.keys(civil.objects)) {
    const match = /^(.*)-(\d+)$/.exec(id);
    if (match?.[1] === category) highest = Math.max(highest, Number(match[2]));
  }
  return `${category}-${highest + 1}`;
}

/** Returns a model with `object` inserted (or replaced) by id; records the issued counter. */
export function withObject(civil: CivilModel, object: CivilObject): CivilModel {
  const exists = civil.objects[object.id] !== undefined;
  const match = /^(.*)-(\d+)$/.exec(object.id);
  const counters =
    match && Number(match[2]) > (civil.counters[match[1] ?? ''] ?? 0)
      ? { ...civil.counters, [match[1] ?? '']: Number(match[2]) }
      : civil.counters;
  return {
    objects: { ...civil.objects, [object.id]: object },
    order: exists ? civil.order : [...civil.order, object.id],
    counters,
  };
}

export function withoutObjects(civil: CivilModel, ids: ReadonlySet<string>): CivilModel {
  const objects = { ...civil.objects };
  for (const id of ids) delete objects[id];
  return { ...civil, objects, order: civil.order.filter((id) => !ids.has(id)) };
}

/** The object `id` when it has `category`, else undefined. */
export function civilObject<C extends CivilCategory>(
  civil: CivilModel,
  id: string,
  category: C,
): Extract<CivilObject, { category: C }> | undefined {
  const object = civil.objects[id];
  return object?.category === category
    ? (object as Extract<CivilObject, { category: C }>)
    : undefined;
}

/** Objects of one category in creation order. */
export function civilObjectsOf<C extends CivilCategory>(
  civil: CivilModel,
  category: C,
): Array<Extract<CivilObject, { category: C }>> {
  return civil.order
    .map((id) => civil.objects[id])
    .filter((object): object is Extract<CivilObject, { category: C }> => {
      return object?.category === category;
    });
}

/** Object ids first (replay / build_project aliases re-link references), then their entities. */
export function civilAffected(document: CadDocument, objectIds: ReadonlyArray<string>): string[] {
  return [...objectIds, ...objectIds.flatMap((id) => document.civil?.objects[id]?.entityIds ?? [])];
}

/** Station label "km+mmm.mm" from a station in metres, e.g. 1234.5 -> "1+234.50". */
export function formatStation(metres: number): string {
  const sign = metres < 0 ? '-' : '';
  const value = Math.abs(metres);
  const kilometres = Math.floor(value / 1000 + 1e-9);
  const rest = value - kilometres * 1000;
  return `${sign}${kilometres}+${rest.toFixed(2).padStart(6, '0')}`;
}

const MM_PER_UNIT: Readonly<Record<DocumentUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** Converts a length given in `unit` into the document's units. */
export function fromUnit(doc: Pick<CadDocument, 'units'>, value: number, unit: DocumentUnit): number {
  return fromMm(doc, value * MM_PER_UNIT[unit]);
}

/** Converts a length given in metres into the document's units. */
export function fromMetres(doc: Pick<CadDocument, 'units'>, metres: number): number {
  return fromMm(doc, metres * 1000);
}

/** A document length in metres as text, without trailing zeros (e.g. "0.5", "12.125"). */
export function toMetresText(doc: Pick<CadDocument, 'units'>, value: number): string {
  return String(Number(toMetres(doc, value).toFixed(3)));
}
