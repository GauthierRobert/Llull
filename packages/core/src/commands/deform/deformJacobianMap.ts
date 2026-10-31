/** deform_jacobian_map — read-only per-vertex det J of a deformation on the deformed body, for a colour map in the viewport (01 DEF M4, FR-DEF-21). */

import type { CadDocument } from '../../model/types';
import { JACOBIAN_FLOOR } from '../../geometry/deform/bounds';
import { warpOf } from '../../geometry/deform/laws';
import { warpMesh } from '../../geometry/deform/meshWarp';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { defRejection } from './codes';
import { deformNodeOf, sourceMeshOf } from './sourceMesh';
import { idParam } from './schema';

/** Triangles the refinement may reach: a closed body then has about 250000 vertices, each carrying 3 coordinates and a determinant (about 30 MB of JSON). */
const MAX_TRIANGLES = 500_000;

/**
 * @affects none (read-only); data = positions (flat world xyz of the deformed body, same refinement as the deform result), indices, determinant per vertex, min / max, folded vertex count
 * @invariant computed on read: the source is re-refined exactly as the deformation did, every vertex carries det J of the map at its REST point and its deformed position; nothing is stored
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; no deform node -> DEF_NOT_DEFORMED; degenerate frame -> DEF_FRAME_DEGENERATE; source not rebuildable -> DEF_SOURCE_UNAVAILABLE; refinement refused or above 500000 triangles -> the warp's code (DEF_BUDGET_EXCEEDED, DEF_APPROX_TOLERANCE)
 */
export const deformJacobianMap = defineCommand({
  name: 'deform_jacobian_map',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Per-vertex Jacobian determinant of a deformation, for a colour map drawn on the deformed body (document units, world coordinates). ' +
    'data: positions (flat [x, y, z, ...] of the deformed body), indices (triangles), determinant (det J of the map at each vertex: 1 = volume kept, > 1 stretched, < 1 compressed, <= 0 folded), ' +
    'min, max, folded (vertices with det J <= 1e-6), floor (that threshold). Computed from the recipe of the entity (its outermost deform node) by re-refining the source as the deformation did; read-only, nothing is stored. ' +
    'Next: analyze_deformation for the closed-form range over the whole body, check_deformation for a verdict.',
  params: z.object({ id: idParam.describe('Id of the deformed mesh entity (the id a deformation command returned in affected).') }),
  run: (doc: CadDocument, { id }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult =>
      defRejection(doc, 'deform_jacobian_map', code, message, [id], ['params.id']);
    const entity = doc.entities[id];
    if (entity === undefined) return fail('DEF_ENTITY_NOT_FOUND', `entity '${id}' not found`);
    const node = deformNodeOf(entity);
    if (node === null) return fail('DEF_NOT_DEFORMED', `entity '${id}' (kind '${entity.kind}') has no deform node in its recipe`);
    const warp = warpOf(node);
    if (warp === null) return fail('DEF_FRAME_DEGENERATE', 'the recorded frame axis is zero or the reference is parallel to it');
    const source = sourceMeshOf(ctx?.kernel ?? null, node.source, doc);
    if (source === null) return fail('DEF_SOURCE_UNAVAILABLE', 'the deformation source cannot be rebuilt without a geometry kernel');
    const warped = warpMesh(source, node, { tolerance: node.output.tolerance, maxTriangles: MAX_TRIANGLES });
    if (!warped.ok) return fail(warped.code, warped.message);
    const count = warped.restPositions.length / 3;
    const determinant: number[] = new Array<number>(count);
    let min = Infinity;
    let max = -Infinity;
    let folded = 0;
    for (let v = 0; v < count; v++) {
      const det = warp.determinant([
        warped.restPositions[v * 3] as number,
        warped.restPositions[v * 3 + 1] as number,
        warped.restPositions[v * 3 + 2] as number,
      ]);
      determinant[v] = det;
      min = Math.min(min, det);
      max = Math.max(max, det);
      if (!(det > JACOBIAN_FLOOR)) folded++;
    }
    const range = count === 0 ? 'no vertices' : `det J ${min.toPrecision(4)} .. ${max.toPrecision(4)}`;
    return report(
      doc,
      `deform_jacobian_map: '${id}' ${node.law.kind}: ${count} vertices, ${range}, ${folded} folded (det J <= ${JACOBIAN_FLOOR}).`,
      {
        id,
        unit: doc.units,
        positions: warped.mesh.positions,
        indices: warped.mesh.indices,
        determinant,
        min: count === 0 ? null : min,
        max: count === 0 ? null : max,
        folded,
        floor: JACOBIAN_FLOOR,
      },
    );
  },
});
