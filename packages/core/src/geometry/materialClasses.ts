/**
 * Material classes (plant 09 VIS §5.6): the named display classes (colour, metalness, roughness), their document overrides and the
 * per-entity assignment. A class is a display attribute: it never changes geometry or `doc.materials`. Pure.
 * @invariant a document class replaces the default of the same id; an assignment naming a class that no longer exists is ignored
 */

import type { DisplayModel, MaterialClass } from '../model/display';
import { is3D, type CadDocument, type Entity } from '../model/types';

const defaults = (rows: ReadonlyArray<readonly [string, string, string | null, number, number]>): ReadonlyArray<MaterialClass> =>
  rows.map(([id, name, colour, metalness, roughness]) => ({ id, name, colour, metalness, roughness }));

/** `matclass:llull-v1`: llull choices, not standard values. A null colour keeps the entity's (or its profile's) colour. */
export const DEFAULT_MATERIAL_CLASSES: ReadonlyArray<MaterialClass> = defaults([
  ['structural_steel_painted', 'Structural steel, painted', null, 0.1, 0.6],
  ['galvanized_steel', 'Galvanized steel', '#a5a8a6', 0.8, 0.45],
  ['carbon_steel_pipe_painted', 'Carbon steel pipe, painted', null, 0.1, 0.5],
  ['stainless_steel', 'Stainless steel', '#c0c4c8', 0.9, 0.3],
  ['insulation_cladding_aluminium', 'Insulation cladding, aluminium', '#c9ccce', 0.85, 0.35],
  ['concrete', 'Concrete', '#9a9a96', 0, 0.9],
  ['grating', 'Grating', '#8f999f', 0.7, 0.5],
  ['cast_steel_valve', 'Cast steel valve', '#2f5fa8', 0.3, 0.5],
  ['alloy_bolting', 'Alloy bolting', '#3a3a3a', 0.6, 0.5],
  ['frp', 'Fibre-reinforced plastic', '#6f8f6a', 0, 0.7],
]);

/** Every class in force: the defaults (in the order above), overridden or extended by `display.materialClasses`. */
export function effectiveMaterialClasses(display: DisplayModel | undefined): MaterialClass[] {
  const own = display?.materialClasses ?? {};
  const merged = new Map<string, MaterialClass>(DEFAULT_MATERIAL_CLASSES.map((entry) => [entry.id, entry]));
  for (const entry of Object.values(own)) merged.set(entry.id, entry);
  return [...merged.values()];
}

/** The class in force with this id, or undefined. */
export function findMaterialClass(display: DisplayModel | undefined, id: string): MaterialClass | undefined {
  const own = display?.materialClasses;
  if (own !== undefined && Object.hasOwn(own, id)) return own[id];
  return DEFAULT_MATERIAL_CLASSES.find((entry) => entry.id === id);
}

/** The class assigned to the entity (assign_material_class) when it still exists, else undefined. */
export function assignedMaterialClass(doc: CadDocument, entityId: string): MaterialClass | undefined {
  const assigned = doc.display?.materialClassOf;
  if (assigned === undefined || !Object.hasOwn(assigned, entityId)) return undefined;
  const id = assigned[entityId];
  return id === undefined ? undefined : findMaterialClass(doc.display, id);
}

/** `entity` drawn in `colour` (a colour replaces the material override, like a profile rule). */
export function recolouredEntity(entity: Entity, colour: string): Entity {
  const { materialId: _material, ...rest } = entity;
  return { ...rest, color: colour } as Entity;
}

/** Colour of the class assigned to a 3D `entity`, or null (no assignment, a class without a colour, a 2D shape or a curve). */
export function materialClassColour(doc: CadDocument, entity: Entity): string | null {
  return is3D(entity) ? (assignedMaterialClass(doc, entity.id)?.colour ?? null) : null;
}

/**
 * `doc` with every 3D entity of a coloured class drawn in the class colour.
 * @invariant the same object when no entity is assigned; 2D entities, classes without a colour and instance children are left alone
 */
export function withMaterialClassColours(doc: CadDocument): CadDocument {
  const assigned = doc.display?.materialClassOf;
  if (assigned === undefined) return doc;
  let entities: Record<string, Entity> | null = null;
  for (const id of Object.keys(assigned)) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    const colour = entity === undefined ? null : materialClassColour(doc, entity);
    if (entity === undefined || colour === null) continue;
    entities ??= { ...doc.entities };
    entities[id] = recolouredEntity(entity, colour);
  }
  return entities === null ? doc : { ...doc, entities };
}
