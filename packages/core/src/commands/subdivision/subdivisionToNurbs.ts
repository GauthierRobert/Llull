import type { CadDocument, Entity, SubdivisionEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { changed } from '../noop';
import { newEntity } from '../entity/newEntity';
import { withEntities, withoutEntities } from '../entity/entityOps';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { nextId } from '../../lib/id';
import { roundSignificant } from '../../lib/significant';
import { recipeOf } from '../../geometry/shapeRecipe';
import { isOpenCage } from '../../geometry/subd/boundary';
import { cageToNurbs } from '../../geometry/subd/toNurbs';
import { buildTopology, faceArea } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { isEntity, subdivisionOf } from './shared';

const COMMAND = 'subdivision_to_nurbs';
const MAX_LISTED_EV_EDGES = 200;
const sig = (value: number): number => roundSignificant(value, 10);

/** Extraordinary vertices (valence other than 4) and n-gon faces of the cage: where Fusion splits and where continuity drops to G1. */
function starPoints(entity: SubdivisionEntity): Array<{ id: string; kind: 'vertex' | 'face'; valence: number }> {
  const topology = buildTopology(entity.vertices.length, entity.faces);
  const vertices = topology.vertexEdges.flatMap((edges, v) =>
    edges.length === (topology.vertexFaces[v] as number[]).length && edges.length !== 4
      ? [{ id: entity.elementIds.vertices[v] as string, kind: 'vertex' as const, valence: edges.length }]
      : [],
  );
  const faces = entity.faces.flatMap((face, f) =>
    face.length === 4 ? [] : [{ id: entity.elementIds.faces[f] as string, kind: 'face' as const, valence: face.length }],
  );
  return [...vertices, ...faces];
}

/**
 * @affects sheets: removes 1 subdivision entity (unless keep), creates one nurbs_surface per patch (or per packed block); solid: creates 1 mesh entity carrying the exact B-rep recipe
 * @invariant regular quads convert exactly (deviation from the Catmull-Clark limit surface ~1e-15); quads next to extraordinary vertices are Loop-Schaefer geometry patches, G0 across every seam (data.maxEvG0 = 0); extraordinary 'G1' (sheets) refines until the measured tangent break along extraordinary-vertex edges is <= tangentToleranceDeg (the break shrinks ~0.43 per level) or 4096 patches are reached, so G1 is met to that tolerance, not exactly; kernel-optional: sheets need no kernel, solid needs the exact native kernel
 * @failure missing id (DIR_ENTITY_NOT_FOUND), solid of an open cage (DIR_CAGE_OPEN), zero-area cage face (DIR_CONVERT_DEGENERATE), solid without an exact kernel (DIR_CONVERT_KERNEL), kernel refuses or returns no triangles (DIR_CONVERT_FAILED) -> no-op
 */
export const subdivisionToNurbs = defineCommand({
  name: COMMAND,
  description:
    'Convert a subdivision solid to exact NURBS geometry for STEP, CAM and booleans. output "sheets" (default, no kernel needed): one bicubic nurbs_surface ' +
    'per patch of the once-refined cage (`faces` "unpacked") or one B-spline surface per maximal block of regular quads (`faces` "packed", fewer entities); ' +
    'regular quads are the exact Catmull-Clark limit surface, quads next to extraordinary vertices are geometry patches that meet G0 (no gaps) with a measured ' +
    'tangent break, which `extraordinary` "G1" reduces below `tangentToleranceDeg` by refining the cage further (more, smaller patches). output "solid": ' +
    'one exact B-rep solid (patches sewn by the native kernel; needs it, always the G0 patches). The SubD is removed unless `keep`. Returns data { patchCount, ' +
    'sheets[] or solid, maxDeviation (document units, from the limit surface at `samples` x `samples` points per patch), evEdges[] { patches, valence, g0, g1Deg }, ' +
    'maxEvG0, maxEvG1Deg, starPoints[] (extraordinary vertices and n-gon faces) }. Refuses a zero-area face (DIR_CONVERT_DEGENERATE) and a solid without the exact kernel ' +
    '(DIR_CONVERT_KERNEL). Next: sew_surfaces, export_step_ap242, check_surface_quality.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    output: z
      .enum(['sheets', 'solid'])
      .describe('"sheets": nurbs_surface entities (default). "solid": one exact B-rep solid (needs the native kernel).')
      .optional(),
    faces: z
      .enum(['unpacked', 'packed'])
      .describe('sheets: "unpacked" (default) = one patch per refined quad; "packed" = one surface per maximal block of regular quads.')
      .optional(),
    extraordinary: z
      .enum(['G0', 'G1'])
      .describe(
        'Treatment of patches around extraordinary vertices: "G0" (default, geometry patches) or "G1" (refine further until the tangent break is below tangentToleranceDeg; sheets only).',
      )
      .optional(),
    tangentToleranceDeg: z
      .number()
      .min(0.01)
      .max(30)
      .describe(
        'extraordinary "G1": largest accepted normal angle in degrees along the edges next to an extraordinary vertex (default 0.5); the cage is refined until met.',
      )
      .optional(),
    keep: z.boolean().describe('true: keep the subdivision solid next to the result. Default false (it is replaced).').optional(),
    samples: z
      .number()
      .int()
      .min(1)
      .max(16)
      .describe('Deviation samples per patch side (a samples x samples grid per patch), 1..16, default 2.')
      .optional(),
  }),
  run: (doc: CadDocument, params, ctx): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const { output = 'sheets', faces = 'unpacked', extraordinary = 'G0', keep = false, samples = 2, tangentToleranceDeg = 0.5 } = params;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const flat = entity.faces.findIndex((face) => faceArea(entity.vertices, face) < 1e-12);
    if (flat >= 0) return reject('DIR_CONVERT_DEGENERATE', `face ${entity.elementIds.faces[flat]} has zero area`, ['params.id']);
    const kernel = (ctx ?? currentContext()).kernel;
    const solid = output === 'solid';
    if (solid && isOpenCage(buildTopology(entity.vertices.length, entity.faces)))
      return reject('DIR_CAGE_OPEN', 'an open cage has no solid: convert to sheets, or close it with fill_cage_hole first', [
        'params.output',
      ]);
    if (solid && (kernel === null || kernel.faceQuery === undefined))
      return reject('DIR_CONVERT_KERNEL', 'the solid output needs the exact native kernel (patches sewn into a B-rep)', ['params.output']);
    const effectiveG1 = extraordinary === 'G1' && !solid;
    const converted = cageToNurbs(entity, {
      packed: faces === 'packed' && !solid,
      tangentToleranceDeg: effectiveG1 ? tangentToleranceDeg : undefined,
      samples,
    });
    const report = {
      patchCount: converted.patchCount,
      refineLevels: converted.refineLevels,
      faces: solid ? 'unpacked' : faces,
      extraordinary: effectiveG1 ? 'G1' : 'G0',
      maxDeviation: sig(converted.maxDeviation),
      deviationSamples: converted.deviationSamples,
      skippedSamples: converted.skippedSamples,
      evEdges: converted.evEdges.slice(0, MAX_LISTED_EV_EDGES).map((e) => ({ ...e, g0: sig(e.g0), g1Deg: sig(e.g1Deg) })),
      maxEvG0: sig(converted.maxEvG0),
      maxEvG1Deg: sig(converted.maxEvG1Deg),
      starPoints: starPoints(entity),
      tangentToleranceDeg: effectiveG1 ? tangentToleranceDeg : null,
      g1ToleranceMet: effectiveG1 ? converted.g1ToleranceMet : null,
      warnings: effectiveG1 && converted.g1ToleranceMet === false ? ['DIR_CONVERT_G1_TOLERANCE_NOT_MET'] : [],
      packedQuads: converted.packedQuads,
      packedBlocks: converted.packedBlocks,
      unit: doc.units,
    };
    const measured =
      `max deviation ${report.maxDeviation} ${doc.units} over ${report.deviationSamples} samples, EV seams: gap ${report.maxEvG0} ${doc.units}, tangent break ${report.maxEvG1Deg} deg` +
      (report.warnings.length > 0
        ? ` [DIR_CONVERT_G1_TOLERANCE_NOT_MET: ${report.maxEvG1Deg} deg > ${tangentToleranceDeg} deg at the 4096-patch budget]`
        : '');
    if (solid && kernel !== null) {
      const built = evaluateRecipe(kernel, recipeOf(entity));
      if (typeof built === 'string')
        return reject('DIR_CONVERT_FAILED', `the kernel ${built === 'refused' ? 'refused the patch solid' : 'returned no triangles'}`, [
          'params.id',
        ]);
      const result = commitKernelResult(
        doc,
        kernel,
        built,
        [entity],
        (newId, triangles) =>
          `${COMMAND}: '${entity.id}' -> exact solid '${newId}' (${converted.patchCount} patches sewn, ${triangles} display triangles; ${measured})`,
        keep,
      );
      const solidId = result.affected[0] as string;
      return { ...result, data: { ...report, output, solid: solidId } };
    }
    const created: Entity[] = converted.surfaces.map((surface) =>
      newEntity('nurbs_surface', nextId('surf'), { surface }, entity.position, entity.color, {
        rotation: entity.rotation,
        layerId: entity.layerId,
      }),
    );
    const base = keep ? doc : withoutEntities(doc, new Set([entity.id])).document;
    const ids = created.map((sheet) => sheet.id);
    return {
      ...changed(
        withEntities(base, created),
        `${COMMAND}: '${entity.id}' -> ${created.length} nurbs_surface sheet(s) from ${converted.patchCount} patches (${faces}, ${report.extraordinary}); ${measured}.`,
        ids,
      ),
      data: { ...report, output, sheets: ids },
    };
  },
});
