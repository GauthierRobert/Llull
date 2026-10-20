/** create_ply_solids: one closed triangle-mesh solid per ply piece and constant-stack region, stacked by ply thickness (06 CMP FR-CMP-54, VC-CMP-30). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { type CadDocument, DEFAULT_LAYER_ID, type Entity } from '@core/model/types';
import { nextId } from '@lib/id';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { piecesOf } from './geometry2d';
import { meshVolume, plyPieceMesh } from './plySolid';
import { autoStepLength } from './drape/plyDrape';
import { stackRegions } from './plyRegions';
import { coresOf, heightBelow } from './sandwich';
import { compositesOf, findPart, findPly, pliesOf } from './state';

const MAX_SOLIDS = 400;
const SOLID_COLOR = '#c8a46a';

/**
 * @affects creates one mesh entity per ply piece (ids plysolid-<step>.<k>), named "<ply> piece <n>", on the layer of the tool solid
 * @invariant each solid is the piece offset along the tool-face normal from the underside height (plies below that cover the point, plus a core between) by the cured ply thickness; the laminate side is respected; closed with outward winding, so volume = area x thickness (within the mesh refinement on curved faces); the solids are a snapshot: they are not regenerated when plies change
 * @failure unknown part / ply -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES; more than 400 pieces or an untriangulable piece -> CMP_PARAM_INVALID
 */
export const createPlySolids = defineCommand({
  name: 'create_ply_solids',
  description:
    'Create one triangle-mesh solid per ply piece of a composite part (split into more solids where the plies below it stop, so each solid sits at one ' +
    'height), offset along the tool-face normal by the cured ply thickness and stacked ' +
    'on the plies below it (a ply on a ramp sits on the plies that cover it; a core created with add_core lifts the plies above it). Each ' +
    'solid is a closed mesh entity named "<ply> piece <n>" on the tool layer, so export_stl (perEntity), export_obj / export_gltf and the ' +
    'mesh STEP path export them; mass_properties measures them. `plies` selects plies by id or name (default all). `maxEdge` (document ' +
    'length units, default the outline diagonal / 16) bounds the triangle edge on curved faces: smaller is smoother and heavier (at most ' +
    '4 refinement levels). The solids are a snapshot of the model now: re-run after editing plies (delete the old ones first). The core ' +
    'itself is not meshed. Computed by llull, not approved.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    plies: z.array(z.string().describe('Ply id or name.')).describe('Plies to mesh; default every ply of the part.').optional(),
    maxEdge: z
      .number()
      .describe('Maximum triangle edge on curved faces, document length units, > 0; default outline diagonal / 16.')
      .optional(),
  }),
  run: (doc, { part: partRef, plies: selection, maxEdge }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'create_ply_solids', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    if (maxEdge !== undefined && !(Number.isFinite(maxEdge) && maxEdge > 0))
      return refuseCmp(doc, 'create_ply_solids', 'CMP_PARAM_INVALID', 'maxEdge must be a number > 0', [part.id], ['params.maxEdge']);
    const chosen = selection === undefined ? pliesOf(model, part.id) : selection.map((ref) => findPly(model, part.id, ref));
    const missing = (selection ?? []).filter((_, i) => chosen[i] === null);
    if (missing.length > 0)
      return refuseCmp(doc, 'create_ply_solids', 'CMP_REF_MISSING', `unknown ply(ies) ${missing.join(', ')}`, [part.id], ['params.plies']);
    const plies = chosen.flatMap((ply) => (ply === null || ply.partId !== part.id ? [] : [ply]));
    if (plies.length === 0)
      return refuseCmp(doc, 'create_ply_solids', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const all = pliesOf(model, part.id);
    const refine = part.surface.type !== 'plane' || coresOf(model, part.id).length > 0;
    const edge = maxEdge ?? autoStepLength(part) * 12.5;
    const layerId = doc.entities[part.toolFaces[0]?.entityId ?? '']?.layerId ?? DEFAULT_LAYER_ID;
    const entities: Record<string, Entity> = { ...doc.entities };
    const order = [...doc.order];
    const created: { id: string; ply: string; volume: number; triangles: number }[] = [];
    for (const ply of plies) {
      const thickness = model.materials[ply.materialName]?.plyThickness;
      if (thickness === undefined)
        return refuseCmp(doc, 'create_ply_solids', 'CMP_REF_MISSING', `ply "${ply.name}" uses unknown material '${ply.materialName}'`, [
          ply.id,
        ]);
      const lower = all.filter((other) => other.order < ply.order);
      for (const [index, piece] of piecesOf(ply, part).entries()) {
        const regions = stackRegions(part, lower, piece);
        for (const [regionIndex, region] of regions.entries()) {
          if (created.length >= MAX_SOLIDS)
            return refuseCmp(
              doc,
              'create_ply_solids',
              'CMP_PARAM_INVALID',
              `more than ${MAX_SOLIDS} solids; mesh fewer plies`,
              [part.id],
              ['params.plies'],
            );
          const mesh = plyPieceMesh(part, region, thickness, (uv) => heightBelow(model, part, ply, uv), edge, refine);
          if (mesh === null)
            return refuseCmp(doc, 'create_ply_solids', 'CMP_PARAM_INVALID', `piece ${index} of ply "${ply.name}" cannot be triangulated`, [
              ply.id,
            ]);
          const id = nextId('plysolid');
          entities[id] = {
            id,
            kind: 'mesh',
            mesh,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            layerId,
            color: SOLID_COLOR,
            name: regions.length === 1 ? `${ply.name} piece ${index + 1}` : `${ply.name} piece ${index + 1}.${regionIndex + 1}`,
          } as Entity;
          order.push(id);
          created.push({ id, ply: ply.id, volume: Math.abs(meshVolume(mesh)), triangles: mesh.indices.length / 3 });
        }
      }
    }
    const result: CadDocument = { ...doc, entities, order };
    const volume = created.reduce((sum, solid) => sum + solid.volume, 0);
    return {
      ...changed(
        result,
        `create_ply_solids: part "${part.name}": ${created.length} solid(s) for ${plies.length} ply(ies), ${created.reduce((n, s) => n + s.triangles, 0)} triangles, total volume ${sig(volume)} ${doc.units}^3 (${created.map((s) => s.id).join(', ')}). Computed by llull, not approved.`,
        created.map((solid) => solid.id),
      ),
      data: {
        part: part.id,
        lengthUnit: doc.units,
        maxEdge: sig(edge),
        solids: created.map((solid) => ({ ...solid, volume: sig(solid.volume) })),
        totalVolume: sig(volume),
        reviewRequired: true,
      },
    };
  },
});
