/** Part facts for the corrosion checks: galvanic group (TR-COR-05), anodic index, surface area and declared isolations of a part. */

import type { CadDocument, Entity } from '@core/model/types';
import { toMm } from '@core/model/units';
import { corrosionOf, materialGalvanicOf, surfaceSystemOfEntity } from './model';
import { groupOf } from './tables';
import type { Isolation, SurfaceSystem } from './types';

/** Root of an id: an instance child "<instance>/<child>" belongs to the entity before the first slash. */
export const rootOf = (id: string): string => id.split('/')[0] ?? id;

const entityOf = (doc: CadDocument, id: string): Entity | undefined => (Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined);

/** Material of a part: its own, or for an instance the single material all its component children share. */
export function materialOfPart(doc: CadDocument, id: string): string | null {
  const entity = entityOf(doc, id);
  if (entity === undefined) return null;
  if (entity.materialId !== undefined) return entity.materialId;
  if (entity.kind !== 'instance' || !Object.hasOwn(doc.components, entity.componentId)) return null;
  const component = doc.components[entity.componentId];
  const materials = new Set(Object.values(component?.entities ?? {}).map((child) => child.materialId ?? null));
  const [only] = [...materials];
  return materials.size === 1 && only !== undefined ? only : null;
}

export interface PartFacts {
  readonly id: string;
  readonly material: string | null;
  readonly group: string | null;
  readonly groupFrom: 'surface_system' | 'material' | null;
  readonly anodicIndexV: number | null;
  readonly indexFrom: 'table' | 'material_override' | null;
  readonly surfaceSystem: string | null;
  /** Total box surface area in mm^2 (MVP closed form, TR-COR-08); null for a solid that is not a box. */
  readonly areaMm2: number | null;
}

/** Surface system of a part: its own, else the one of the instance it belongs to. */
function systemOfPart(doc: CadDocument, id: string): SurfaceSystem | undefined {
  return surfaceSystemOfEntity(doc, id) ?? surfaceSystemOfEntity(doc, rootOf(id));
}

/**
 * Galvanic facts of the part `id` whose material is `material`: group = outermost metallic_plating layer of its surface system, else the material's
 * group; index = the table value of the group, overridden by the material's own anodicIndexV when the group comes from the material.
 */
export function partFacts(doc: CadDocument, id: string, material: string | null): PartFacts {
  const system = systemOfPart(doc, id);
  const plating = [...(system?.layers ?? [])].reverse().find((layer) => layer.class === 'metallic_plating')?.galvanicGroup;
  const galvanic = material === null ? undefined : materialGalvanicOf(doc, material);
  const group = plating ?? galvanic?.galvanicGroup ?? null;
  const override = plating === undefined ? galvanic?.anodicIndexV : undefined;
  const tableValue = group === null ? null : (groupOf(group)?.anodicIndexV ?? null);
  const entity = entityOf(doc, id);
  const [w, h, d] = entity?.kind === 'box' ? entity.size : [0, 0, 0];
  const scale = toMm(doc, 1) ** 2;
  return {
    id,
    material,
    group,
    groupFrom: group === null ? null : plating === undefined ? 'material' : 'surface_system',
    anodicIndexV: override ?? tableValue,
    indexFrom: group === null || (override ?? tableValue) === null ? null : override === undefined ? 'table' : 'material_override',
    surfaceSystem: system?.id ?? null,
    areaMm2: entity?.kind === 'box' ? 2 * (w * h + h * d + w * d) * scale : null,
  };
}

const covers = (member: string, part: string): boolean => member === part || member === rootOf(part);

/** The declared isolations that cover the contact between parts `a` and `b` (a pair in either order, or one of the parts). */
export function isolationsOf(doc: CadDocument, a: string, b: string): Isolation[] {
  return Object.values(corrosionOf(doc).isolations).filter((isolation) =>
    isolation.pair !== undefined
      ? (covers(isolation.pair[0], a) && covers(isolation.pair[1], b)) || (covers(isolation.pair[0], b) && covers(isolation.pair[1], a))
      : isolation.entityId !== undefined && (covers(isolation.entityId, a) || covers(isolation.entityId, b)),
  );
}
