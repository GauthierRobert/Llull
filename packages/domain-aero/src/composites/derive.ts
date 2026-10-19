/** Ply outlines are derived from the ply boundaries (06 CMP §3): omitted from saved files, re-derived on load, read-only (architecture L8). Planar parts only. */

import { newEntity } from '@core/commands/entity/newEntity';
import type { DerivationGuard } from '@core/commands/derivation';
import type { CompositePart, CompositesModel, Ply } from '@core/model/composites';
import { DEFAULT_LAYER_ID, type CadDocument, type Entity } from '@core/model/types';
import { eulerFromAxes } from '@lib/eulerRotation';
import { add3, cross3, scale3 } from '@lib/vec3';
import { piecesOf } from './geometry2d';

const OUTLINE_COLOR = '#2563eb';
const OUTLINE_ID = /^ply-\d+\.\d+\.o\d+$/;

/** Ids of the outline entities of one ply (one per boundary piece), planar parts only. */
export const outlineIdsOf = (ply: Ply, part: CompositePart | undefined): string[] =>
  part === undefined || part.surface.type !== 'plane' ? [] : piecesOf(ply, part).map((_, k) => `${ply.id}.o${k}`);

/** Height (document units) of the middle of each ply above the tool face, by ply id. */
function plyHeights(model: CompositesModel, partId: string): Map<string, number> {
  const heights = new Map<string, number>();
  let z = 0;
  for (const ply of model.plyOrder
    .map((id) => model.plies[id])
    .filter((p): p is Ply => p !== undefined && p.partId === partId)
    .sort((a, b) => a.order - b.order)) {
    const t = model.materials[ply.materialName]?.plyThickness ?? 0;
    heights.set(ply.id, z + t / 2);
    z += t;
  }
  return heights;
}

/** The outline polylines of every ply of `model` (placed on the face, lifted to the ply mid-height), with their ids. */
export function outlineEntities(model: CompositesModel, layerOf: (part: CompositePart) => string): Entity[] {
  return Object.values(model.parts).flatMap((part) => {
    const { surface } = part;
    if (surface.type !== 'plane') return [];
    const heights = plyHeights(model, part.id);
    const side = part.laminateSide === 'positive_normal' ? 1 : -1;
    const rotation = eulerFromAxes(surface.xDir, surface.yDir, cross3(surface.xDir, surface.yDir));
    return model.plyOrder
      .map((id) => model.plies[id])
      .filter((ply): ply is Ply => ply !== undefined && ply.partId === part.id)
      .flatMap((ply) =>
        piecesOf(ply, part).map((piece, k) =>
          newEntity(
            'polyline',
            `${ply.id}.o${k}`,
            { points: piece, closed: true },
            add3(surface.origin, scale3(surface.normal, side * (heights.get(ply.id) ?? 0))),
            OUTLINE_COLOR,
            { rotation, name: `${ply.name} outline`, layerId: layerOf(part) },
          ),
        ),
      );
  });
}

const layerFor =
  (doc: Pick<CadDocument, 'entities'>) =>
  (part: CompositePart): string =>
    doc.entities[part.toolFaces[0]?.entityId ?? '']?.layerId ?? DEFAULT_LAYER_ID;

/** `doc` with every outline entity regenerated from the composites model (stale ones removed). */
export function syncOutlines(doc: CadDocument): CadDocument {
  const stale = Object.keys(doc.entities).filter((id) => OUTLINE_ID.test(id));
  const base: CadDocument =
    stale.length === 0
      ? doc
      : {
          ...doc,
          entities: Object.fromEntries(Object.entries(doc.entities).filter(([id]) => !OUTLINE_ID.test(id))),
          order: doc.order.filter((id) => !OUTLINE_ID.test(id)),
        };
  const fresh = doc.composites === undefined ? [] : outlineEntities(doc.composites, layerFor(base));
  if (fresh.length === 0) return base;
  return {
    ...base,
    entities: { ...base.entities, ...Object.fromEntries(fresh.map((entity) => [entity.id, entity])) },
    order: [...base.order, ...fresh.map((entity) => entity.id)],
  };
}

const sameEntity = (a: Entity | undefined, b: Entity | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/** Outlines change only through composites commands (those replace `composites`). */
export const compositesDerivationGuard: DerivationGuard = {
  domain: 'composites',
  check(previous: CadDocument, next: CadDocument) {
    if (next.composites !== previous.composites || next.entities === previous.entities) return null;
    const edited = Object.keys(previous.entities).filter(
      (id) => OUTLINE_ID.test(id) && !sameEntity(previous.entities[id], next.entities[id]),
    );
    if (edited.length === 0) return null;
    return `it would edit the derived outline(s) ${edited.join(', ')} of composite plies. Edit the ply instead (edit_ply, delete_ply, define_zone + generate_plies_from_zones) — derived geometry is read-only.`;
  },
};
