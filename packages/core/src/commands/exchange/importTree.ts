/**
 * Product tree of an imported STEP file as document structure (aerospace 04 XCH M3, TR-XCH-08): every assembly product becomes a component holding
 * instances of its children, every part product a component holding its solids, every placed occurrence an instance (a part used several times is
 * ONE component). A free single part keeps the flat form (its solids are top-level entities), so a plain part file imports as before.
 * @invariant ids are minted in a fixed order (components by product index, then instances by occurrence order), so replay re-mints them
 */

import type { Component, Entity, Vec3 } from '../../model/types';
import type { ImportedExchange, ImportedOccurrence } from '../../geometry/kernelExchange';
import { eulerFromMat } from '../../lib/axisRotation';
import { nextId } from '../../lib/id';
import { instanceEntity } from '../assembly/assemblies';

/** Where one product of the file ended up. */
export interface ProductPlacement {
  /** The component holding the product (absent for a free single part kept flat). */
  readonly componentId?: string;
  /** Top-level entity ids standing for the product (the solids of a flat part, or the root instance of an assembly). */
  readonly topLevel: readonly string[];
}

export interface TreeStructure {
  /** Entities to add at the top level, in order. */
  readonly topLevel: readonly Entity[];
  readonly components: Readonly<Record<string, Component>>;
  readonly placements: ReadonlyMap<number, ProductPlacement>;
  /** Occurrences whose placement is not a rigid motion (mirrored / scaled): placed unrotated, named here. */
  readonly nonRigid: readonly string[];
}

const withoutNegativeZero = ([x, y, z]: Vec3): Vec3 => [x + 0, y + 0, z + 0];

/** Position (document units) and Euler rotation of a row-major 3x4 placement given in millimetres. */
export function placementOf(matrix: ImportedOccurrence['matrix'], mmPerUnit: number): { position: Vec3; rotation: Vec3; rigid: boolean } {
  const m = (index: number): number => matrix[index] ?? 0;
  const rotation = [m(0), m(1), m(2), m(4), m(5), m(6), m(8), m(9), m(10)] as const;
  const determinant =
    rotation[0] * (rotation[4] * rotation[8] - rotation[5] * rotation[7]) -
    rotation[1] * (rotation[3] * rotation[8] - rotation[5] * rotation[6]) +
    rotation[2] * (rotation[3] * rotation[7] - rotation[4] * rotation[6]);
  const rigid = Math.abs(determinant - 1) < 1e-6;
  return {
    position: [m(3) / mmPerUnit, m(7) / mmPerUnit, m(11) / mmPerUnit],
    rotation: rigid ? withoutNegativeZero(eulerFromMat(rotation)) : [0, 0, 0],
    rigid,
  };
}

const isFlatPart = (imported: ImportedExchange, index: number): boolean => {
  const product = imported.products[index];
  return product !== undefined && !product.assembly && !imported.occurrences.some((use) => use.parent === index);
};

/**
 * Structure of `imported` over the already built solid `entities` (aligned with `imported.solids`).
 * @param flatNames names a flat part's solid entities are given (index in the product's solids)
 */
export function buildTreeStructure(imported: ImportedExchange, entities: readonly Entity[], mmPerUnit: number): TreeStructure {
  const components: Record<string, Component> = {};
  const componentOf = new Map<number, string>();
  const placements = new Map<number, ProductPlacement>();
  const topLevel: Entity[] = [];
  const nonRigid: string[] = [];
  const solidEntities = (index: number): Entity[] =>
    (imported.products[index]?.solids ?? []).flatMap((solid) => {
      const entity = entities[solid];
      return entity === undefined ? [] : [entity];
    });

  // components first (by product index): every product that is not a free single part
  const flatRoots = new Set(imported.roots.filter((root) => isFlatPart(imported, root)));
  for (const [index, product] of imported.products.entries()) {
    if (flatRoots.has(index)) continue;
    const id = nextId('comp-stp');
    componentOf.set(index, id);
    components[id] = { id, name: product.name === '' ? id : product.name, entities: {}, order: [] };
  }
  for (const [index, id] of componentOf) {
    const component = components[id];
    if (component === undefined) continue;
    const members: Entity[] = [...solidEntities(index)];
    for (const use of imported.occurrences) {
      if (use.parent !== index) continue;
      const child = componentOf.get(use.product);
      if (child === undefined) continue;
      const placement = placementOf(use.matrix, mmPerUnit);
      if (!placement.rigid) nonRigid.push(use.name);
      members.push({ ...instanceEntity(nextId('instance'), child, placement.position, placement.rotation), name: use.name });
    }
    components[id] = {
      ...component,
      entities: Object.fromEntries(members.map((member) => [member.id, member])),
      order: members.map((member) => member.id),
    };
    placements.set(index, { componentId: id, topLevel: [] });
  }
  for (const root of imported.roots) {
    const component = componentOf.get(root);
    if (component === undefined) {
      const flat = solidEntities(root);
      topLevel.push(...flat);
      placements.set(root, { topLevel: flat.map((entity) => entity.id) });
    } else {
      const instance = instanceEntity(nextId('instance'), component, [0, 0, 0], [0, 0, 0]);
      const named = { ...instance, name: imported.products[root]?.name ?? component };
      topLevel.push(named);
      placements.set(root, { componentId: component, topLevel: [named.id] });
    }
  }
  return { topLevel, components, placements, nonRigid };
}
