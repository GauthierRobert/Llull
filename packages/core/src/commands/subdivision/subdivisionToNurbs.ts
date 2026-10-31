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

/** A G1 solution whose deviation from the limit surface exceeds this multiple of the plain patches carries DIR_CONVERT_G1_SHAPE_MOVED. */
const SHAPE_MOVED_RATIO = 3;
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
 * @invariant regular quads convert exactly (deviation from the Catmull-Clark limit surface ~1e-15); quads next to extraordinary vertices are Loop-Schaefer geometry patches, G0 across every seam (data.maxEvG0 = 0); extraordinary 'G1' (sheets) builds the exact G1 solution (the linear tangent-plane conditions: interior poles, and where that has no solution the inner edge poles between free quads too, same patch count and corner poles; every edge G1 to about 1e-8 rad) and the approximate tangent-plane fit, and keeps by g1Solve: 'auto' (default) the exact one when it meets tangentToleranceDeg and its deviation from the limit surface is at most max(1.25 x the fit, deviationTolerance), else the fit (the exact one when only it meets the tolerance); 'exact' / 'fit' force one; the exact solve costs position (data.maxDeviation against data.plainMaxDeviation: 3.3x on a cube, 11 to 15x on boxes with several segments, 1.1x on cylinders; DIR_CONVERT_G1_SHAPE_MOVED above 3x), its solve is bounded (a work budget, a named refusal per group in data.exactG1Refused, no retry at finer levels once refused); then refines until the measured tangent break along extraordinary-vertex edges is <= tangentToleranceDeg or 4096 patches are reached; kernel-optional: sheets need no kernel, solid needs the exact native kernel
 * @failure missing id (DIR_ENTITY_NOT_FOUND), solid of an open cage (DIR_CAGE_OPEN), zero-area cage face (DIR_CONVERT_DEGENERATE), solid without an exact kernel (DIR_CONVERT_KERNEL), kernel refuses or returns no triangles (DIR_CONVERT_FAILED) -> no-op
 */
export const subdivisionToNurbs = defineCommand({
  name: COMMAND,
  description:
    'Convert a subdivision solid to exact NURBS geometry for STEP, CAM and booleans. output "sheets" (default, no kernel needed): one bicubic nurbs_surface ' +
    'per patch of the once-refined cage (`faces` "unpacked") or one B-spline surface per maximal block of regular quads (`faces` "packed", fewer entities); ' +
    'regular quads are the exact Catmull-Clark limit surface, quads next to extraordinary vertices are geometry patches that meet G0 (no gaps) with a measured ' +
    'tangent break, which `extraordinary` "G1" removes first, with the same patch count and corner points. `g1Solve` "auto" (default) builds both an EXACT solution (the linear tangent-plane conditions for the poles of those quads and of the edges between them: every edge G1 to about 1e-8 rad) and the approximate tangent-plane fit (0.1 to 0.5 degrees), and keeps the exact one only when its deviation from the Catmull-Clark limit surface is at most max(1.25 x the fit deviation, `deviationTolerance`), because exactness costs POSITION (data.maxDeviation against data.plainMaxDeviation and data.deviationRatio: 3.3x on a cube, 11 to 15x on boxes with several segments, about 1.1x on cylinders; DIR_CONVERT_G1_SHAPE_MOVED above 3x) and the boundary curves between the quads near an extraordinary vertex change (G0 stays 0); data.g1Choice says which was kept and why, data.g1Method "exact" or "fit", data.g1Exact { method, freeQuads, objective } for the exact one, data.exactG1Refused the groups it could not solve (contradiction, degenerate edge, work budget). "exact" forces the exact solution (the fit where none exists), "fit" the fit. Then, if `tangentToleranceDeg` is still not met, by refining the cage further (more, smaller patches). output "solid": ' +
    'one exact B-rep solid (patches sewn by the native kernel; needs it, always the G0 patches). The SubD is removed unless `keep`. Returns data { patchCount, ' +
    'sheets[] or solid, maxDeviation (document units, from the limit surface at `samples` x `samples` points per patch), evEdges[] { patches, valence, g0, g1Deg }, ' +
    'maxEvG0, maxEvG1Deg, plainMaxDeviation, deviationRatio, g1Method, g1Choice, g1Exact, exactG1Refused[], warnings[], starPoints[] (extraordinary vertices and n-gon faces) }. Refuses a zero-area face (DIR_CONVERT_DEGENERATE) and a solid without the exact kernel ' +
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
        'Treatment of patches around extraordinary vertices: "G0" (default, geometry patches) or "G1" (sheets only: exact where the linear tangent-plane conditions are solvable, see g1Solve and data.g1Method, otherwise the approximate fit; then refine further until the measured tangent break is <= tangentToleranceDeg or 4096 patches; edges at creases are not counted).',
      )
      .optional(),
    g1Solve: z
      .enum(['auto', 'exact', 'fit'])
      .describe(
        'extraordinary "G1": "auto" (default) keeps the exact G1 solution (break about 1e-8 rad) when its deviation from the limit surface is at most max(1.25 x the fit, deviationTolerance), else the approximate fit (break 0.1 to 0.5 degrees, a small position change); "exact" / "fit" force one (data.maxDeviation, data.plainMaxDeviation and data.g1Choice show what it cost).',
      )
      .optional(),
    deviationTolerance: z
      .number()
      .positive()
      .describe(
        'g1Solve "auto": the deviation from the limit surface (document units) up to which the exact solution is accepted whatever the fit does; default 1e-3 x the diagonal of the cage.',
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
    const {
      output = 'sheets',
      faces = 'unpacked',
      extraordinary = 'G0',
      keep = false,
      samples = 2,
      tangentToleranceDeg = 0.5,
      deviationTolerance,
      g1Solve = 'auto',
    } = params;
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
      fitTangents: effectiveG1,
      g1Solve,
      ...(deviationTolerance === undefined ? {} : { deviationTolerance }),
      samples,
    });
    const shapeRatio =
      effectiveG1 && converted.plainMaxDeviation !== null && converted.plainMaxDeviation > 0
        ? converted.maxDeviation / converted.plainMaxDeviation
        : null;
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
      g1Method: effectiveG1 ? converted.g1Method : null,
      g1Exact:
        converted.exactMethod === null
          ? null
          : {
              method: converted.exactMethod,
              freeQuads: converted.exactFreeQuads,
              patchCount: converted.patchCount,
              objective: converted.exactObjective,
            },
      g1Choice:
        converted.g1Choice === null
          ? null
          : {
              ...converted.g1Choice,
              exactDeviation: converted.g1Choice.exactDeviation === null ? null : sig(converted.g1Choice.exactDeviation),
              fitDeviation: converted.g1Choice.fitDeviation === null ? null : sig(converted.g1Choice.fitDeviation),
            },
      plainMaxDeviation: converted.plainMaxDeviation === null ? null : sig(converted.plainMaxDeviation),
      deviationRatio: shapeRatio === null ? null : sig(shapeRatio),
      exactG1Refused: converted.exactRefused.map((group) => ({ ...group, residual: sig(group.residual) })),
      warnings: [
        ...(effectiveG1 && converted.g1ToleranceMet === false ? ['DIR_CONVERT_G1_TOLERANCE_NOT_MET'] : []),
        ...(shapeRatio !== null && shapeRatio > SHAPE_MOVED_RATIO ? ['DIR_CONVERT_G1_SHAPE_MOVED'] : []),
      ],
      packedQuads: converted.packedQuads,
      packedBlocks: converted.packedBlocks,
      unit: doc.units,
    };
    const g1Label = !effectiveG1
      ? 'G0'
      : converted.g1Method === 'exact'
        ? 'G1 exact'
        : converted.g1Method === 'fit'
          ? converted.exactRefused.length > 0
            ? `G1 fit (${converted.exactRefused.length} group(s) refused by the exact solve)`
            : 'G1 fit'
          : 'G1';
    const measured =
      `max deviation ${report.maxDeviation} ${doc.units} over ${report.deviationSamples} samples, EV seams: gap ${report.maxEvG0} ${doc.units}, tangent break ${report.maxEvG1Deg} deg` +
      (report.warnings.includes('DIR_CONVERT_G1_TOLERANCE_NOT_MET')
        ? ` [DIR_CONVERT_G1_TOLERANCE_NOT_MET: ${report.maxEvG1Deg} deg > ${tangentToleranceDeg} deg at the 4096-patch budget]`
        : '') +
      (report.warnings.includes('DIR_CONVERT_G1_SHAPE_MOVED')
        ? ` [DIR_CONVERT_G1_SHAPE_MOVED: ${g1Label}, deviation ${report.maxDeviation} ${doc.units} = ${report.deviationRatio}x the G0 patches]`
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
        `${COMMAND}: '${entity.id}' -> ${created.length} nurbs_surface sheet(s) from ${converted.patchCount} patches (${faces}, ${g1Label}); ${measured}.`,
        ids,
      ),
      data: { ...report, output, sheets: ids },
    };
  },
});
