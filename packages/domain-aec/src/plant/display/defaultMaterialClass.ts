/**
 * Default material class of plant objects (plant 09 VIS §5.6, `matclass:llull-v1`): the class an entity is shaded with when
 * `assign_material_class` has not set one, derived from the element category or the run part kind at render time (no document write, so old
 * documents get it too). Published to core as the entity property `defaultMaterialClass`.
 * @invariant pure; undefined for categories with no steel / concrete default (walls, doors, rooms, ...)
 */

import type { BuildingElement } from '../../building/types';

const BY_CATEGORY: Readonly<Record<string, string>> = {
  grating: 'grating',
  railing: 'galvanized_steel',
  ladder: 'galvanized_steel',
  steelStair: 'galvanized_steel',
  tray: 'galvanized_steel',
  member: 'structural_steel_painted',
  pipeSupport: 'structural_steel_painted',
  connection: 'structural_steel_painted',
  equipment: 'structural_steel_painted',
  pipe: 'carbon_steel_pipe_painted',
};

/** Structural elements take their class from the material text: steel members are painted steel, concrete elements are concrete. */
function byMaterial(material: string): string | undefined {
  const text = material.toLowerCase();
  if (text.includes('steel')) return 'structural_steel_painted';
  return text.includes('concrete') ? 'concrete' : undefined;
}

/** Default class of a building element (plant structures, equipment, building pipes), or undefined. */
export function defaultClassOfElement(element: BuildingElement): string | undefined {
  const fixed = Object.hasOwn(BY_CATEGORY, element.category) ? BY_CATEGORY[element.category] : undefined;
  if (fixed !== undefined) return fixed;
  const structural =
    element.category === 'column' || element.category === 'beam' || element.category === 'slab' || element.category === 'footing';
  return structural ? byMaterial(element.material) : undefined;
}

/** Default class of a plant piping run part (`<runId>/<kind>-<k>`): valves are cast steel, every other part is carbon steel pipe. */
export function defaultClassOfRunPart(partKind: string | undefined): string {
  return partKind === 'valve' ? 'cast_steel_valve' : 'carbon_steel_pipe_painted';
}
