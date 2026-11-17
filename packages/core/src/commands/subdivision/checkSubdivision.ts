import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { recipeOf } from '../../geometry/shapeRecipe';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { report } from '../noop';
import { edgeSharpnessMap } from '../../geometry/subd/sharpness';
import { symmetryDeviation } from '../../geometry/subd/symmetry';
import { type CageTopology, buildTopology } from '../../geometry/subd/topology';
import { boundaryLoops } from '../../geometry/subd/boundary';
import { levelMeshVolume, limitVolumeEstimate } from '../../geometry/subd/volume';
import {
  type Finding,
  degenerateFaceFindings,
  extraordinaryFindings,
  patchSeamFindings,
  selfIntersectionFindings,
  sharpnessBudgetFindings,
  symmetryFindings,
  volumeFindings,
} from './checkSubdivisionFindings';
import { isEntity, subdivisionOf } from './shared';

const COMMAND = 'check_subdivision';

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

/** Number of connected components of the cage (union-find over its edges). */
function componentCount(vertexCount: number, topology: CageTopology): number {
  const parents = Array.from({ length: vertexCount }, (_, v) => v);
  const find = (v: number): number => ((parents[v] as number) === v ? v : (parents[v] = find(parents[v] as number)));
  for (const { a, b } of topology.edges) parents[find(a)] = find(b);
  return new Set(parents.map((_, v) => find(v))).size;
}

interface Limits {
  readonly symmetry: number;
  readonly meshVsLimitRel: number;
  readonly patchSeamGap: number;
  readonly patchSeamAngleRad: number;
}

type Tolerances = {
  readonly symmetry?: number | undefined;
  readonly meshVsLimitRel?: number | undefined;
  readonly patchSeamGap?: number | undefined;
  readonly patchSeamAngleRad?: number | undefined;
};

/** The tolerances as reported in data: the value used, its unit, whether it is the named default and where the default comes from. */
function toleranceRows(limits: Limits, given: Tolerances | undefined, unit: string): Array<Record<string, unknown>> {
  return [
    {
      name: 'symmetry',
      value: limits.symmetry,
      unit,
      defaulted: given?.symmetry === undefined,
      source: 'llull choice: 1e-9 x cage diagonal',
    },
    {
      name: 'meshVsLimitRel',
      value: limits.meshVsLimitRel,
      unit: 'relative',
      defaulted: given?.meshVsLimitRel === undefined,
      source: 'llull choice: 0.5 %',
    },
    {
      name: 'patchSeamGap',
      value: limits.patchSeamGap,
      unit,
      defaulted: given?.patchSeamGap === undefined,
      source: 'llull choice: 1e-6 x cage diagonal',
    },
    {
      name: 'patchSeamAngleRad',
      value: limits.patchSeamAngleRad,
      unit: 'rad',
      defaulted: given?.patchSeamAngleRad === undefined,
      source: 'llull choice: 0.05 rad',
    },
  ];
}

/**
 * @affects none (read-only); data = status, findings, extraordinaryHistogram, creases, symmetry { maxDeviation }, euler, genus, meshVolume, limitVolumeEstimate, limitPatches (kernel), tolerances, provenance
 * @invariant status is "fail" when a finding fails, "warn" when only warnings remain, else "pass"; defaulted tolerances are listed with their source
 * @failure missing id (DIR_ENTITY_NOT_FOUND) -> refusal; findings are data, never refusals
 * @invariant kernel-optional: with exactSeams true and ctx.kernel (exact B-rep + face queries) data.limitPatches reports the exact patch solid's volume and seam continuity; without it null
 */
export const checkSubdivision = defineCommand({
  name: COMMAND,
  annotations: { kernelOptional: true, readOnly: true },
  description:
    'Pass / warn / fail verdict for a subdivision solid with coded findings: DIR_CHECK_DEGENERATE_FACE (fail: a zero-area cage face), ' +
    'DIR_CHECK_SELF_INTERSECTION (fail: the level mesh crosses itself), DIR_CHECK_SYMMETRY_DEVIATION (warn: declared symmetry violated), ' +
    'DIR_CHECK_LEVEL_MESH_DEVIATION (warn: the level-mesh and limit-surface solids differ by more than `meshVsLimitRel` relative), ' +
    'DIR_CHECK_EXTRAORDINARY (info: vertices of valence other than 4 and n-gon faces). data also has the valence histogram, crease counts, ' +
    'Euler characteristic and genus, data.meshVolume (what mass_properties reports without the exact kernel), data.limitVolumeEstimate (extrapolated ' +
    'limit surface) and, with `exactSeams` true on the exact native kernel, data.limitPatches (patch solid, worst seam gap and tangent angle: seconds on a cage of some dozens of vertices, so it is opt-in), in ' +
    'document units^3. Next: edit_subdivision_cage, set_cage_crease, evaluate_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    exactSeams: z
      .boolean()
      .describe(
        'true: with the native kernel also sew the exact patch solid and measure its seams (data.limitPatches). Slow (seconds on a 70-vertex level-3 cage); default false.',
      )
      .optional(),
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
    const limits: Limits = {
      symmetry: params.tolerances?.symmetry ?? 1e-9 * size,
      meshVsLimitRel: params.tolerances?.meshVsLimitRel ?? 0.005,
      patchSeamGap: params.tolerances?.patchSeamGap ?? 1e-6 * size,
      patchSeamAngleRad: params.tolerances?.patchSeamAngleRad ?? 0.05,
    };
    findings.push(...degenerateFaceFindings(entity, size));
    const intersections = selfIntersectionFindings(entity);
    const level = intersections.level;
    findings.push(...intersections.findings);
    const deviation = entity.symmetry === undefined ? 0 : symmetryDeviation(entity.vertices, entity.symmetry);
    findings.push(...symmetryFindings(entity, deviation, limits.symmetry, doc.units));
    const loops = boundaryLoops(topology);
    const open = loops.length > 0;
    const meshVolume = open ? null : levelMeshVolume(entity, entity.levels);
    const estimate = open ? null : limitVolumeEstimate(entity);
    const volumeRatio =
      estimate === null || meshVolume === null ? null : Math.abs(meshVolume - estimate.volume) / Math.abs(estimate.volume);
    findings.push(...volumeFindings(entity, open, meshVolume, estimate, volumeRatio, limits.meshVsLimitRel));
    const extraordinary = extraordinaryFindings(entity, topology);
    findings.push(...extraordinary.findings, ...sharpnessBudgetFindings(entity));
    const euler = entity.vertices.length - topology.edges.length + entity.faces.length;
    const components = componentCount(entity.vertices.length, topology);
    const kernel = (ctx ?? currentContext()).kernel;
    const patches = open || params.exactSeams !== true ? null : limitPatches(kernel, entity);
    findings.push(...patchSeamFindings(entity, patches, limits.patchSeamGap, limits.patchSeamAngleRad, doc.units));
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
    const sharp = edgeSharpnessMap(entity);
    const data = {
      status,
      findings,
      extraordinaryHistogram: extraordinary.histogram,
      creases: {
        infinite: entity.creases.length,
        semiSharp: entity.edgeSharpness?.length ?? 0,
        sharpEdges: [...sharp.values()].filter((s) => s > 0).length,
        corners: entity.vertexSharpness?.length ?? 0,
        method: entity.creaseMethod ?? 'uniform',
      },
      symmetry: { planes: entity.symmetry?.planes ?? [], maxDeviation: deviation },
      euler,
      genus: (2 * components - euler - loops.length) / 2,
      components,
      open,
      boundary: open ? (entity.boundary ?? 'edge_and_corner') : null,
      boundaryLoops: loops.map((loop) => loop.map((v) => entity.elementIds.vertices[v] as string)),
      meshVolume,
      limitVolumeEstimate: estimate === null ? null : estimate.volume,
      limitPatches: patches,
      tolerances: toleranceRows(limits, params.tolerances, doc.units),
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
        (meshVolume === null
          ? `open surface, ${loops.length} boundary loop(s), no volume`
          : `level-${entity.levels} mesh volume ${meshVolume.toPrecision(10)}`) +
        (estimate === null ? '' : `, limit estimate ${estimate.volume.toPrecision(8)}`) +
        '.',
      data,
    );
  },
});
