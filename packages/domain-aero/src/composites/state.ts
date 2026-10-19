/** Read / write access to `CadDocument.composites` (absent until the first composites command) and reference lookup by id or name. */

import type { CompositePart, CompositesModel, Ply, Rosette, Zone } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';

const EMPTY: CompositesModel = { materials: {}, rosettes: {}, parts: {}, zones: {}, plies: {}, plyOrder: [], waivers: {} };

/** `value` without its undefined-valued properties (exactOptionalPropertyTypes). */
export const compact = <T extends object>(value: { readonly [K in keyof T]?: T[K] | undefined }): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

export const compositesOf = (doc: CadDocument): CompositesModel => doc.composites ?? EMPTY;

export const withComposites = (doc: CadDocument, patch: Partial<CompositesModel>): CadDocument => ({
  ...doc,
  composites: { ...compositesOf(doc), ...patch },
});

const byIdOrName = <T extends { readonly id: string; readonly name: string }>(table: Readonly<Record<string, T>>, ref: string): T | null =>
  table[ref] ?? Object.values(table).find((item) => item.name === ref) ?? null;

export const findPart = (model: CompositesModel, ref: string): CompositePart | null => byIdOrName(model.parts, ref);
export const findRosette = (model: CompositesModel, ref: string): Rosette | null => byIdOrName(model.rosettes, ref);

/** A zone of `partId` by id or name. */
export const findZone = (model: CompositesModel, partId: string, ref: string): Zone | null =>
  byIdOrName(Object.fromEntries(Object.entries(model.zones).filter(([, zone]) => zone.partId === partId)), ref);

/** A ply by id or by name within `partId`. */
export const findPly = (model: CompositesModel, partId: string, ref: string): Ply | null =>
  model.plies[ref] ?? Object.values(model.plies).find((ply) => ply.partId === partId && ply.name === ref) ?? null;

/** Plies of `partId` in stacking order (tool side first). */
export const pliesOf = (model: CompositesModel, partId: string): Ply[] =>
  model.plyOrder
    .map((id) => model.plies[id])
    .filter((ply): ply is Ply => ply !== undefined && ply.partId === partId)
    .sort((a, b) => a.order - b.order);

export const zonesOf = (model: CompositesModel, partId: string): Zone[] =>
  Object.values(model.zones)
    .filter((zone) => zone.partId === partId)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
