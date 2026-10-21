/**
 * geometric_validation_properties (aerospace 04 XCH M1, TR-XCH-02): the CAx-IF validation properties of the model's own geometry (volume,
 * surface area, centre of volume, bounding box), the values `export_step_ap242` writes and `verify_exchange_file` / the import check compare.
 */

import { type CadDocument, type Entity, type Vec3, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { noop, report } from '../noop';
import { resolveMassProperties, type MassContext } from '../../geometry/resolveMassProperties';
import { entityBoundsInDoc } from '../../geometry/bounds';
import { expandInstance } from '../../geometry/instanceExpansion';
import { exactOrMesh } from '../kernelShape';

interface GvpItem {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly volume: number;
  readonly area: number | null;
  readonly centroid: Vec3;
  readonly bbox: readonly [number, number, number, number, number, number];
  readonly method: 'brep' | 'closed-form' | 'mesh';
}

const METHOD: Readonly<Record<'exact' | 'closed-form' | 'mesh', GvpItem['method']>> = {
  exact: 'brep',
  'closed-form': 'closed-form',
  mesh: 'mesh',
};

type Method = GvpItem['method'];
const RANK: Readonly<Record<Method, number>> = { brep: 0, 'closed-form': 1, mesh: 2 };

interface Piece {
  readonly volume: number;
  readonly area: number | null;
  readonly centroid: Vec3;
  readonly min: Vec3;
  readonly max: Vec3;
  readonly method: Method;
}

const MAX_NESTING = 4;

/** One solid: the exact kernel B-rep when the kernel integrates it (the shape export_step_ap242 writes), else the closed form / mesh resolver. */
function solidPiece(doc: CadDocument, entity: Entity, ctx: MassContext): Piece | null {
  const kernel = ctx.kernel ?? null;
  if (kernel?.massProperties !== undefined) {
    const shape = exactOrMesh(kernel, entity).shape;
    const exact = shape === null ? null : kernel.massProperties(shape);
    if (exact !== null && exact.volume > 0)
      return {
        volume: exact.volume,
        area: exact.area,
        centroid: exact.centroid,
        min: exact.bounds.min,
        max: exact.bounds.max,
        method: 'brep',
      };
  }
  const mass = resolveMassProperties(doc, entity, () => 1, ctx);
  if (mass === null || !(mass.properties.volume > 0)) return null;
  const bounds = mass.bounds ?? entityBoundsInDoc(doc, entity);
  return {
    volume: mass.properties.volume,
    area: mass.area ?? null,
    centroid: mass.properties.centerOfMass,
    min: bounds.min,
    max: bounds.max,
    method: METHOD[mass.method],
  };
}

function combined(pieces: readonly Piece[]): Piece | null {
  const volume = pieces.reduce((sum, piece) => sum + piece.volume, 0);
  if (pieces.length === 0 || !(volume > 0)) return null;
  const axis = (k: 0 | 1 | 2): number => pieces.reduce((sum, piece) => sum + piece.volume * piece.centroid[k], 0) / volume;
  const low = (k: 0 | 1 | 2): number => Math.min(...pieces.map((piece) => piece.min[k]));
  const high = (k: 0 | 1 | 2): number => Math.max(...pieces.map((piece) => piece.max[k]));
  return {
    volume,
    area: pieces.every((piece) => piece.area !== null) ? pieces.reduce((sum, piece) => sum + (piece.area ?? 0), 0) : null,
    centroid: [axis(0), axis(1), axis(2)],
    min: [low(0), low(1), low(2)],
    max: [high(0), high(1), high(2)],
    method: pieces.reduce<Method>((worst, piece) => (RANK[piece.method] > RANK[worst] ? piece.method : worst), 'brep'),
  };
}

/** An entity or instance (its baked solids combined) in world space. */
function pieceOf(doc: CadDocument, entity: Entity, ctx: MassContext, depth = 0): Piece | null {
  if (entity.kind !== 'instance') return solidPiece(doc, entity, ctx);
  const component = doc.components[entity.componentId];
  if (component === undefined || depth >= MAX_NESTING) return null;
  const parts = expandInstance(entity, component).flatMap((child) => pieceOf(doc, child, ctx, depth + 1) ?? []);
  return combined(parts);
}

/** One entity's validation properties in document units (density 1), or null when it has no volume. */
export function gvpOfEntity(doc: CadDocument, entity: Entity, ctx: MassContext): GvpItem | null {
  const piece = pieceOf(doc, entity, ctx);
  if (piece === null) return null;
  return {
    id: entity.id,
    name: entity.name ?? entity.id,
    kind: entity.kind,
    volume: piece.volume,
    area: piece.area,
    centroid: piece.centroid,
    bbox: [...piece.min, ...piece.max],
    method: piece.method,
  };
}

/**
 * @affects nothing — read-only
 * @invariant data = { unit, items[{id,name,kind,volume,area,centroid,bbox,method}], assemblies[{id,name,solids,volume,area,centroid}] }; lengths in
 *   document units; volume / area are unit-density values (the same ones export_step_ap242 writes as GVP)
 * @failure unknown id, 2D entity, entity without volume -> listed in skipped; no 3D solid at all -> no-op
 */
export const geometricValidationProperties = defineCommand({
  name: 'geometric_validation_properties',
  annotations: { readOnly: true },
  description:
    'Compute the CAx-IF geometric validation properties of 3D solids: volume, surface area, centre of volume (centroid) and bounding box, in document ' +
    'units (volume in units^3, area in units^2). These are the values export_step_ap242 embeds in a STEP file and verify_exchange_file compares with what ' +
    'a sender embedded. method says how each was integrated: brep (exact kernel B-rep), closed-form (analytic primitive) or mesh (triangles; less exact). ' +
    'Use mass_properties for mass and inertia from a material density, measure_bounding_box for the bounding box alone. Instances are reported under assemblies (all their solids combined, world placement applied). Does not modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of the solids or instances to measure. Omit or pass [] for every 3D entity of the document.'),
    includeAssemblies: z
      .boolean()
      .optional()
      .describe('Report component instances as combined assemblies (volume, area, centroid of all their solids). Default true.'),
  }),
  run: (doc, { entityIds, includeAssemblies }, ctx): CommandResult => {
    const context = ctx ?? currentContext();
    const ids = entityIds !== undefined && entityIds.length > 0 ? entityIds : doc.order;
    const items: GvpItem[] = [];
    const assemblies: Array<Omit<GvpItem, 'bbox' | 'method' | 'kind'> & { solids: number; bbox: GvpItem['bbox'] }> = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined) skipped.push(`${id} (not found)`);
      else if (!is3D(entity)) {
        if (entityIds !== undefined && entityIds.length > 0) skipped.push(`${id} (not a 3D solid)`);
      } else {
        const item = gvpOfEntity(doc, entity, context);
        if (item === null) skipped.push(`${id} (no volume)`);
        else if (entity.kind === 'instance') {
          if (includeAssemblies !== false)
            assemblies.push({
              id: item.id,
              name: item.name,
              solids: doc.components[entity.componentId]?.order.length ?? 0,
              volume: item.volume,
              area: item.area,
              centroid: item.centroid,
              bbox: item.bbox,
            });
        } else items.push(item);
      }
    }
    if (items.length === 0 && assemblies.length === 0)
      return noop(
        doc,
        `geometric_validation_properties: no 3D solid with a volume to measure${skipped.length > 0 ? `; skipped ${skipped.join(', ')}` : ''}.`,
      );
    const mesh = items.filter((item) => item.method === 'mesh').map((item) => item.id);
    const lines = [...items, ...assemblies].map(
      (item) =>
        `${item.id} V=${item.volume.toPrecision(10)} A=${item.area === null ? 'n/a' : item.area.toPrecision(10)} c=[${item.centroid.map((v) => Number(v.toPrecision(8))).join(', ')}]`,
    );
    return report(
      doc,
      `geometric_validation_properties: ${items.length} solid(s) and ${assemblies.length} assembl${assemblies.length === 1 ? 'y' : 'ies'} in ${doc.units} (volume in ${doc.units}^3, area in ${doc.units}^2): ${lines.join('; ')}.` +
        (mesh.length > 0 ? ` ${mesh.join(', ')} integrated from triangles (method mesh).` : '') +
        (skipped.length > 0 ? ` Skipped ${skipped.join(', ')}.` : ''),
      { unit: doc.units, volumeUnit: `${doc.units}^3`, areaUnit: `${doc.units}^2`, items, assemblies, skipped },
    );
  },
});
