/** create_implicit_body: realise a field as a derived, read-only mesh solid (05 IMP 4.3). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { CadDocument, MeshData, MeshSolidEntity } from '@core/model/types';
import { nextId } from '@lib/id';
import { meshMeasures } from '@lib/isosurface/measures';
import { refuseImplicit } from './codes';
import { type ImplicitBody, fieldOf, withBody } from './model';
import { realiseField } from './realise';

const IMPLICIT_LAYER_ID = 'layer-implicit';
const HIDDEN_LAYER_ID = 'layer-implicit-hidden';
const BODY_COLOR = '#d9b26f';

/** The derived, read-only mesh entity of a body (also rebuilt when a saved file is loaded). */
export function bodyEntity(id: string, field: string, name: string, color: string, mesh: MeshData): MeshSolidEntity {
  return {
    id,
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: IMPLICIT_LAYER_ID,
    color,
    name,
    tags: [`implicit:${field}`],
    mesh,
  };
}

/** `doc` with the layer `id` present. */
function withLayer(doc: CadDocument, id: string, name: string, visible: boolean): CadDocument {
  if (Object.hasOwn(doc.layers, id)) return doc;
  return { ...doc, layers: { ...doc.layers, [id]: { id, name, visible, locked: false } }, layerOrder: [...doc.layerOrder, id] };
}

/**
 * @affects creates 1 derived mesh entity `imp-<step>.<k>` (read-only, layer layer-implicit) and the body record doc.implicit.bodies[id]; hideSource entities move to the hidden layer layer-implicit-hidden
 * @invariant closed, oriented, edge-manifold mesh (data.closedManifold); budgets are checked before sampling; the saved file keeps the recipe and contentHash, not the triangles (re-derived on load)
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown field -> IMP_FIELD_NOT_FOUND; unknown hideSource -> IMP_ENTITY_NOT_FOUND; no support and no bounds -> IMP_FIELD_UNBOUNDED; too many samples -> IMP_GRID_BUDGET; too many triangles -> IMP_TRIANGLE_BUDGET; nothing inside -> IMP_BODY_EMPTY; voxel <= 0 -> IMP_PARAM_RANGE
 */
export const createImplicitBody = defineCommand({
  name: 'create_implicit_body',
  description:
    'Realise an implicit FIELD as a closed triangle mesh solid (derived and read-only: change the field nodes and run this again). voxel is the grid spacing in document units: error is second order (volume error ~ 0.6 (voxel/smallest feature radius)^2). ' +
    "Bounds default to the field's support box (primitives, clipped lattices); a bare lattice or plane needs `bounds` or a region. " +
    'Budgets are checked before sampling: a grid above the engine limit is refused with IMP_GRID_BUDGET (use a coarser voxel or the native engine), and a mesh above maxTriangles with IMP_TRIANGLE_BUDGET. ' +
    'hideSource moves the listed solids (e.g. the part the field came from) to a hidden layer. Next: implicit_properties, lattice_properties, check_implicit, export_3mf / export_stl.',
  params: z.object({
    field: z.string().describe('Id of the field node to realise.'),
    voxel: z.number().describe('Grid spacing in document units (> 0). Halve it for 4x smaller error and 8x more samples.'),
    bounds: z
      .object({ min: vec3('Lower corner [x, y, z] in document units.'), max: vec3('Upper corner [x, y, z] in document units.') })
      .optional()
      .describe('Box to realise. Default: the support box of the field. The grid is padded by 2 voxels so the surface closes.'),
    maxTriangles: z.number().optional().describe('Refuse a mesh with more triangles than this. Default 5000000.'),
    hideSource: z
      .array(z.string())
      .optional()
      .describe('Ids of solids to move to a hidden layer once the body exists (kept, not deleted).'),
    name: z.string().optional().describe('Optional name of the body.'),
    color: z.string().optional().describe('Optional hex colour of the body, e.g. "#d9b26f".'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], path?: string): CommandResult =>
      refuseImplicit(doc, 'create_implicit_body', code, message, ids, path === undefined ? [] : [`params.${path}`]);
    if (fieldOf(doc, p.field) === undefined) return fail('IMP_FIELD_NOT_FOUND', `no field '${p.field}'`, [p.field], 'field');
    if (!(Number.isFinite(p.voxel) && p.voxel > 0)) return fail('IMP_PARAM_RANGE', `voxel must be > 0 (got ${p.voxel})`, [], 'voxel');
    const hidden = p.hideSource ?? [];
    const unknown = hidden.find((id) => !Object.hasOwn(doc.entities, id));
    if (unknown !== undefined)
      return fail('IMP_ENTITY_NOT_FOUND', `hideSource entity '${unknown}' does not exist`, [unknown], 'hideSource');
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const realised = realiseField(
      doc,
      { field: p.field, voxel: p.voxel, bounds: p.bounds ?? null, maxTriangles: p.maxTriangles ?? engine.limits.maxTriangles },
      engine,
    );
    if (!realised.ok) return fail(realised.code, realised.message, realised.ids);
    const id = nextId('imp');
    const name = p.name ?? `implicit ${p.field}`;
    const color = p.color ?? BODY_COLOR;
    const entity = bodyEntity(id, p.field, name, color, realised.mesh);
    const body: ImplicitBody = {
      id,
      field: p.field,
      voxel: p.voxel,
      bounds: realised.bounds,
      mesher: 'tetra',
      engine: realised.result.provenance.engine,
      name,
      color,
      contentHash: realised.contentHash,
      hiddenSources: hidden,
    };
    let next: CadDocument = withLayer(doc, IMPLICIT_LAYER_ID, 'implicit', true);
    if (hidden.length > 0) next = withLayer(next, HIDDEN_LAYER_ID, 'implicit sources (hidden)', false);
    const entities = { ...next.entities, [id]: entity };
    for (const source of hidden) {
      const original = entities[source];
      if (original !== undefined) entities[source] = { ...original, layerId: HIDDEN_LAYER_ID };
    }
    next = withBody({ ...next, entities, order: [...next.order, id] }, body);
    const measures = meshMeasures(realised.mesh);
    const { result } = realised;
    const errorEstimate = Number.isFinite(realised.minFeature)
      ? 0.6 * (p.voxel / realised.minFeature) ** 2 * Math.abs(measures.volume)
      : null;
    const triangles = measures.triangles;
    return {
      document: next,
      summary: `create_implicit_body: ${id} from field ${p.field} — ${triangles} triangles, volume ${measures.volume.toPrecision(6)} ${doc.units}^3 (mesh), voxel ${p.voxel}, ${result.closedManifold ? 'closed manifold' : 'NOT closed manifold'}, ${result.samples} grid samples (${(result.prunedFraction * 100).toFixed(0)}% pruned), engine ${result.provenance.engine}${realised.unverified ? ', UNVERIFIED input' : ''}. Next: implicit_properties id=${id}, check_implicit id=${id}.`,
      affected: [id],
      data: {
        id,
        field: p.field,
        triangles,
        vertices: measures.vertices,
        volumeMesh: measures.volume,
        area: measures.area,
        volumeUnit: `${doc.units}^3`,
        errorEstimate:
          errorEstimate === null
            ? null
            : { value: errorEstimate, kind: 'estimated', formula: '0.6 (voxel / smallest feature radius)^2 * volume' },
        closedManifold: result.closedManifold,
        bounds: realised.bounds,
        voxel: p.voxel,
        contentHash: realised.contentHash,
        distanceQuality: realised.program.quality,
        unverified: realised.unverified,
        hiddenSources: hidden,
        warnings: realised.warnings,
        provenance: {
          method: 'marching tetrahedra (6 Kuhn tets per cube), interval-pruned',
          ...result.provenance,
          samples: result.samples,
          evaluatedSamples: result.evaluatedSamples,
          prunedFraction: result.prunedFraction,
          maxVertexResidual: result.maxVertexResidual,
          nonFiniteSamples: result.nonFiniteSamples,
        },
        unit: doc.units,
      },
    };
  },
});
