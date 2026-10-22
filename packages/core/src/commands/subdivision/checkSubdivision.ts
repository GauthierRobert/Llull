import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { CommandResult } from '../types';
import type { GeometryKernel } from '../../geometry/kernel';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { report } from '../noop';
import { recipeOf } from '../../geometry/shapeRecipe';
import { findSelfIntersections } from '../../geometry/mesh/selfIntersection';
import { subdivide } from '../../geometry/subdivision';
import { edgeSharpnessMap } from '../../geometry/subd/sharpness';
import { symmetryDeviation } from '../../geometry/subd/symmetry';
import { buildTopology, faceArea } from '../../geometry/subd/topology';
import { levelMeshVolume, levelQuadCount, limitVolumeEstimate } from '../../geometry/subd/volume';
import { isEntity, subdivisionOf } from './shared';

const COMMAND = 'check_subdivision';
/** Triangle budget of the self-intersection test (the grid test is roughly linear in it). */
const SELF_INTERSECTION_TRIANGLES = 20_000;

interface Finding {
  readonly code: string;
  readonly severity: 'fail' | 'warn' | 'info';
  readonly ids: readonly string[];
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly message: string;
  readonly remediation: string;
}

/** Exact-kernel view of the cage (OCC patches): volume and the worst seam gap / angle between neighbouring patches, or null without a kernel. */
function limitPatches(kernel: GeometryKernel | null, entity: SubdivisionEntity): Record<string, number> | null {
  const shape = kernel?.faceQuery === undefined ? null : kernel.evaluate(recipeOf(entity));
  if (kernel === null || shape === null || kernel.faceQuery === undefined) return null;
  const mass = kernel.massProperties?.(shape) ?? null;
  const graph = kernel.faceQuery.faceGraph(shape);
  let [gap, angle, seams] = [0, 0, 0];
  graph?.edgeFaces.forEach((around, edge) => {
    if (around.length !== 2) return;
    const samples = kernel.faceQuery?.edgeContinuity(shape, edge, 8) ?? null;
    if (samples === null) return;
    seams++;
    for (const sample of samples) [gap, angle] = [Math.max(gap, sample.g0), Math.max(angle, sample.g1)];
  });
  return mass === null ? null : { volume: mass.volume, seams, maxG0Gap: gap, maxG1AngleRad: angle };
}

/**
 * @affects none (read-only); data = status, findings, extraordinaryHistogram, creases, symmetry { maxDeviation }, euler, genus, meshVolume, limitVolumeEstimate, limitPatches (kernel), tolerances, provenance
 * @invariant status is "fail" when a finding fails, "warn" when only warnings remain, else "pass"; defaulted tolerances are listed with their source
 * @failure missing id (DIR_ENTITY_NOT_FOUND) -> refusal; findings are data, never refusals
 * @invariant kernel-optional: with ctx.kernel (exact B-rep + face queries) data.limitPatches reports the exact patch solid's volume and seam continuity; without it null
 */
export const checkSubdivision = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Pass / warn / fail verdict for a subdivision solid with coded findings: DIR_CHECK_DEGENERATE_FACE (fail: a zero-area cage face), ' +
    'DIR_CHECK_SELF_INTERSECTION (fail: the level mesh crosses itself), DIR_CHECK_SYMMETRY_DEVIATION (warn: declared symmetry violated), ' +
    'DIR_CHECK_LEVEL_MESH_DEVIATION (warn: the level-mesh and limit-surface solids differ by more than `meshVsLimitRel` relative), ' +
    'DIR_CHECK_EXTRAORDINARY (info: vertices of valence other than 4 and n-gon faces). data also has the valence histogram, crease counts, ' +
    'Euler characteristic and genus, data.meshVolume (what mass_properties reports without the exact kernel), data.limitVolumeEstimate (extrapolated ' +
    'limit surface) and, with the exact native kernel, data.limitPatches (patch solid, worst seam gap and tangent angle), in ' +
    'document units^3. Next: edit_subdivision_cage, set_cage_crease, evaluate_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    tolerances: z
      .object({
        symmetry: z
          .number()
          .positive()
          .describe('Largest accepted symmetry deviation, document units. Default 1e-9 x cage diagonal.')
          .optional(),
        meshVsLimitRel: z
          .number()
          .positive()
          .describe('Largest accepted relative difference between level-mesh and limit volume. Default 0.005.')
          .optional(),
        patchSeamGap: z
          .number()
          .positive()
          .describe(
            'Largest accepted position gap between neighbouring exact patches, document units (exact kernel only). Default 1e-6 x cage diagonal.',
          )
          .optional(),
        patchSeamAngleRad: z
          .number()
          .positive()
          .describe('Largest accepted tangent-plane angle between neighbouring exact patches, radians (exact kernel only). Default 0.05.')
          .optional(),
      })
      .describe('Acceptance limits; omitted ones use the named defaults reported in data.tolerances.')
      .optional(),
  }),
  run: (doc: CadDocument, params, ctx): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const findings: Finding[] = [];
    const size = Math.hypot(
      ...[0, 1, 2].map(
        (axis) => Math.max(...entity.vertices.map((p) => p[axis] as number)) - Math.min(...entity.vertices.map((p) => p[axis] as number)),
      ),
    );
    const symmetryLimit = params.tolerances?.symmetry ?? 1e-9 * size;
    const volumeLimit = params.tolerances?.meshVsLimitRel ?? 0.005;
    const gapLimit = params.tolerances?.patchSeamGap ?? 1e-6 * size;
    const angleLimit = params.tolerances?.patchSeamAngleRad ?? 0.05;
    const flat = entity.faces.flatMap((face, f) => (faceArea(entity.vertices, face) < 1e-12 * size * size ? [f] : []));
    if (flat.length > 0)
      findings.push({
        code: 'DIR_CHECK_DEGENERATE_FACE',
        severity: 'fail',
        ids: flat.map((f) => entity.elementIds.faces[f] as string),
        value: flat.length,
        limit: 0,
        unit: 'faces',
        message: `${flat.length} cage face(s) have zero area`,
        remediation: 'move or merge the vertices of those faces',
      });
    const level =
      [entity.levels, 2, 1, 0].find((l) => l <= entity.levels && 2 * levelQuadCount(entity, l) <= SELF_INTERSECTION_TRIANGLES) ?? 0;
    const mesh = subdivide(entity, level);
    const triangles = mesh.faces.flatMap((face) =>
      face.slice(2).flatMap((_, k) => [face[0] as number, face[k + 1] as number, face[k + 2] as number]),
    );
    const crossings = findSelfIntersections(mesh.vertices.flat(), triangles, 8);
    if (crossings.count > 0)
      findings.push({
        code: 'DIR_CHECK_SELF_INTERSECTION',
        severity: 'fail',
        ids: [entity.id],
        value: crossings.count,
        limit: 0,
        unit: 'triangle pairs',
        message: `the level-${level} mesh crosses itself in ${crossings.count} place(s)`,
        remediation: 'pull the intersecting parts of the cage apart',
      });
    if (level < entity.levels)
      findings.push({
        code: 'DIR_CHECK_SELF_INTERSECTION_PARTIAL',
        severity: 'warn',
        ids: [entity.id],
        value: level,
        limit: entity.levels,
        unit: 'levels',
        message: `self-intersection was tested on the level-${level} mesh only (level ${entity.levels} is above the ${SELF_INTERSECTION_TRIANGLES}-triangle budget)`,
        remediation: 'lower levels to run the full test, or check a coarser cage',
      });
    const deviation = entity.symmetry === undefined ? 0 : symmetryDeviation(entity.vertices, entity.symmetry);
    if (entity.symmetry !== undefined && deviation > symmetryLimit)
      findings.push({
        code: 'DIR_CHECK_SYMMETRY_DEVIATION',
        severity: 'warn',
        ids: [entity.id],
        value: deviation,
        limit: symmetryLimit,
        unit: doc.units,
        message: `the cage deviates ${deviation.toExponential(3)} from its declared mirror symmetry`,
        remediation: 'run set_cage_symmetry with snap true',
      });
    const meshVolume = levelMeshVolume(entity, entity.levels);
    const estimate = limitVolumeEstimate(entity);
    const volumeRatio = estimate === null ? null : Math.abs(meshVolume - estimate.volume) / Math.abs(estimate.volume);
    if (estimate === null)
      findings.push({
        code: 'DIR_CHECK_LIMIT_VOLUME_UNAVAILABLE',
        severity: 'warn',
        ids: [entity.id],
        value: 0,
        limit: 0,
        unit: 'volume',
        message: 'the cage is too large for the limit-volume estimate: the level-mesh deviation was not checked',
        remediation: 'check a coarser cage or use the exact kernel (data.limitPatches)',
      });
    else if (volumeRatio === null || !Number.isFinite(volumeRatio))
      findings.push({
        code: 'DIR_CHECK_VOLUME_NON_FINITE',
        severity: 'warn',
        ids: [entity.id],
        value: Number.NaN,
        limit: volumeLimit,
        unit: 'relative',
        message: `the volumes (level mesh ${meshVolume}, limit estimate ${estimate.volume}) cannot be compared`,
        remediation: 'the cage is degenerate or inside out: check the winding and the face areas',
      });
    else if (volumeRatio > volumeLimit)
      findings.push({
        code: 'DIR_CHECK_LEVEL_MESH_DEVIATION',
        severity: 'warn',
        ids: [entity.id],
        value: volumeRatio,
        limit: volumeLimit,
        unit: 'relative',
        message: `the level-${entity.levels} mesh volume ${meshVolume.toPrecision(10)} differs from the limit-surface volume ${estimate.volume.toPrecision(8)}`,
        remediation: 'raise levels, or use the exact kernel (mass_properties then measures the limit patches)',
      });
    const histogram: Record<string, number> = {};
    const extraordinary: string[] = [];
    (topology.vertexEdges as number[][]).forEach((edges, v) => {
      if (edges.length === 4) return;
      histogram[String(edges.length)] = (histogram[String(edges.length)] ?? 0) + 1;
      extraordinary.push(entity.elementIds.vertices[v] as string);
    });
    const ngons = entity.faces.flatMap((face, f) => (face.length === 4 ? [] : [entity.elementIds.faces[f] as string]));
    if (extraordinary.length > 0 || ngons.length > 0)
      findings.push({
        code: 'DIR_CHECK_EXTRAORDINARY',
        severity: 'info',
        ids: [...extraordinary, ...ngons],
        value: extraordinary.length + ngons.length,
        limit: 0,
        unit: 'elements',
        message: `${extraordinary.length} extraordinary vertex(es), ${ngons.length} n-gon face(s): the limit surface is only G1 there`,
        remediation: 'none needed; a regular quad cage is C2 everywhere',
      });
    const euler = entity.vertices.length - topology.edges.length + entity.faces.length;
    const parents = entity.vertices.map((_, v) => v);
    const find = (v: number): number => ((parents[v] as number) === v ? v : (parents[v] = find(parents[v] as number)));
    for (const { a, b } of topology.edges) parents[find(a)] = find(b);
    const components = new Set(entity.vertices.map((_, v) => find(v))).size;
    const kernel = (ctx ?? currentContext()).kernel;
    const patches = limitPatches(kernel, entity);
    if (patches !== null && (patches['maxG0Gap'] as number) > gapLimit)
      findings.push({
        code: 'DIR_CHECK_PATCH_SEAM_GAP',
        severity: 'warn',
        ids: [entity.id],
        value: patches['maxG0Gap'] as number,
        limit: gapLimit,
        unit: doc.units,
        message: `neighbouring exact patches are up to ${(patches['maxG0Gap'] as number).toExponential(3)} apart`,
        remediation: 'the exact solid may fail to sew: simplify creases near extraordinary vertices',
      });
    if (patches !== null && (patches['maxG1AngleRad'] as number) > angleLimit)
      findings.push({
        code: 'DIR_CHECK_PATCH_SEAM_ANGLE',
        severity: 'warn',
        ids: [entity.id],
        value: patches['maxG1AngleRad'] as number,
        limit: angleLimit,
        unit: 'rad',
        message: `neighbouring exact patches meet at up to ${(patches['maxG1AngleRad'] as number).toExponential(3)} rad (C0 at extraordinary vertices and creases)`,
        remediation: 'expected next to extraordinary vertices; otherwise add loops to regularise the cage',
      });
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
    const sharp = edgeSharpnessMap(entity);
    const data = {
      status,
      findings,
      extraordinaryHistogram: histogram,
      creases: {
        infinite: entity.creases.length,
        semiSharp: entity.edgeSharpness?.length ?? 0,
        sharpEdges: [...sharp.values()].filter((s) => s > 0).length,
        corners: entity.vertexSharpness?.length ?? 0,
        method: entity.creaseMethod ?? 'uniform',
      },
      symmetry: { planes: entity.symmetry?.planes ?? [], maxDeviation: deviation },
      euler,
      genus: (2 * components - euler) / 2,
      components,
      meshVolume,
      limitVolumeEstimate: estimate === null ? null : estimate.volume,
      limitPatches: patches,
      tolerances: [
        {
          name: 'symmetry',
          value: symmetryLimit,
          unit: doc.units,
          defaulted: params.tolerances?.symmetry === undefined,
          source: 'llull choice: 1e-9 x cage diagonal',
        },
        {
          name: 'meshVsLimitRel',
          value: volumeLimit,
          unit: 'relative',
          defaulted: params.tolerances?.meshVsLimitRel === undefined,
          source: 'llull choice: 0.5 %',
        },
        {
          name: 'patchSeamGap',
          value: gapLimit,
          unit: doc.units,
          defaulted: params.tolerances?.patchSeamGap === undefined,
          source: 'llull choice: 1e-6 x cage diagonal',
        },
        {
          name: 'patchSeamAngleRad',
          value: angleLimit,
          unit: 'rad',
          defaulted: params.tolerances?.patchSeamAngleRad === undefined,
          source: 'llull choice: 0.05 rad',
        },
      ],
      provenance: {
        scheme: 'Catmull-Clark',
        creaseRule: entity.creaseMethod === 'chaikin' ? 'OpenSubdiv Chaikin' : 'OpenSubdiv uniform',
        levels: entity.levels,
        selfIntersectionLevel: level,
        limitVolumeMethod:
          estimate === null
            ? 'not run (cage too large)'
            : `ratio-1/4 extrapolation of level meshes ${estimate.level - 1} and ${estimate.level}`,
        kernel: kernel === null ? null : (kernel.name ?? 'kernel'),
      },
    };
    return report(
      doc,
      `${COMMAND}: '${entity.id}' — ${status}; ${findings.length} finding(s) [${findings.map((f) => f.code).join(', ')}]; Euler ${euler}, genus ${data.genus}; ` +
        `level-${entity.levels} mesh volume ${meshVolume.toPrecision(10)}` +
        (estimate === null ? '' : `, limit estimate ${estimate.volume.toPrecision(8)}`) +
        '.',
      data,
    );
  },
});
