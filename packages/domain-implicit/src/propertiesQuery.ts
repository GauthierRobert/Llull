/** implicit_properties: volume with an error statement, area, relative density, bounds, components and enclosed voids (05 IMP 4.4, 5.8). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import { refuseImplicit } from './codes';
import { implicitBodyField } from './bodyField';
import { compileField } from './compile';
import { quadratureVolume, regionProgram, measureVoxel } from './measure';
import { bodyMeshMeasures, isRefusal, propertiesReport, resolveRequest } from './propertiesPhases';

/**
 * @affects none (read-only); data = volume, volumeMesh, volumeQuadrature, errorEstimate, area, relativeDensity, bounds, components, enclosedVoids, unit, provenance, unverified
 * @invariant data.measured says what was measured: 'body mesh', 'field', or 'bounds-clipped solid' for a body created with explicit bounds (the field
 *   intersected with the bounds box, the solid fea_mesh source implicit_field meshes; its display mesh is open at the bounds and not read, so area is null; 14 FLL-D8); it passes the same gate as fea_mesh (implicitBodyField)
 * @invariant volume is the mesh volume of a body (divergence theorem) or the field quadrature of a field; with a region it is the quadrature clipped to that region; errorEstimate = |quadrature(h) - quadrature(1.25 h)| + the mesher estimate, labelled estimated
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure explicit-bounds body older than its field / moved -> IMP_BODY_STALE / FLL_IMPLICIT_FIELD_MISSING (implicitBodyField); unknown id / region -> IMP_FIELD_NOT_FOUND; unbounded field -> IMP_FIELD_UNBOUNDED; over the sample limit -> IMP_GRID_BUDGET
 */
export const implicitProperties = defineCommand({
  name: 'implicit_properties',
  description:
    'Measure an implicit body (id from create_implicit_body) or field (id from add_field_primitive / add_tpms_lattice...): volume with an error estimate, mesh area, relative density ' +
    '(volume / region volume; the region defaults to the support box), bounds, number of solid components and enclosed voids (volume and a point inside each). ' +
    'A body created with explicit bounds is measured as the field clipped to its bounds box (data.measured = bounds-clipped solid, the FE solid), by quadrature: its display mesh is open at the bounds, so area is null. ' +
    'region (a field id) restricts the volume and the density to that region, e.g. the box a lattice fills. Volumes are in document units cubed. Strut lattices use a low-discrepancy quadrature (an aligned grid would alias with the struts).',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    id: z.string().describe('Id of an implicit body or of a field node.'),
    region: z.string().optional().describe('Field id restricting the measure (volume, density). Default: no restriction.'),
    voxel: z.number().optional().describe('Measure grid spacing in document units. Default: about 2^19 cells over the support box.'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const target = resolveRequest(doc, p);
    if (isRefusal(target)) return target;
    const clipped = target.body?.explicitBounds === true;
    const gated = clipped && target.body !== undefined ? implicitBodyField(doc, target.body.id) : null;
    if (gated !== null && !gated.ok) return refuseImplicit(doc, 'implicit_properties', gated.code, gated.message, [p.id], ['params.id']);
    const compiled = gated?.ok === true ? gated.compiled : compileField(doc, target.fieldId);
    if (!compiled.ok) return refuseImplicit(doc, 'implicit_properties', compiled.code, compiled.message, compiled.ids);
    const region = regionProgram(doc, p.region);
    if (region !== null && 'message' in region)
      return refuseImplicit(doc, 'implicit_properties', region.code, region.message, p.region === undefined ? [] : [p.region]);
    const box = target.body?.bounds ?? compiled.program.bounds ?? (region === null ? null : region.bounds);
    if (box === null)
      return refuseImplicit(
        doc,
        'implicit_properties',
        'IMP_FIELD_UNBOUNDED',
        `field '${target.fieldId}' has no finite support: give a region`,
        [target.fieldId],
      );
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const voxel = measureVoxel(box, p.voxel, target.body?.voxel !== undefined ? target.body.voxel / 4 : 0);
    const quadrature = quadratureVolume(engine, compiled.program, region, box, voxel);
    if ('code' in quadrature) return refuseImplicit(doc, 'implicit_properties', quadrature.code, quadrature.message, [p.id]);
    const mesh = clipped ? null : bodyMeshMeasures(doc, p.id, target, ctx);
    if (mesh !== null && isRefusal(mesh)) return mesh;
    return propertiesReport(doc, {
      id: p.id,
      region: p.region,
      target,
      compiled,
      regionClipped: region !== null,
      box,
      engine,
      voxel,
      quadrature,
      mesh,
      measured: clipped ? 'bounds-clipped solid' : target.body === undefined ? 'field' : 'body mesh',
    });
  },
});
