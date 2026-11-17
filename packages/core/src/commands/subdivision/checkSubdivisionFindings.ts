import type { SubdivisionEntity } from '../../model/types';
import { findSelfIntersections } from '../../geometry/mesh/selfIntersection';
import { subdivide } from '../../geometry/subdivision';
import { fullSettleLevels, settleBudgetProblem, settleLevels } from '../../geometry/subd/settle';
import { type CageTopology, faceArea } from '../../geometry/subd/topology';
import { levelQuadCount } from '../../geometry/subd/volume';

/** Triangle budget of the self-intersection test (the grid test is roughly linear in it). */
const SELF_INTERSECTION_TRIANGLES = 20_000;

export interface Finding {
  readonly code: string;
  readonly severity: 'fail' | 'warn' | 'info';
  readonly ids: readonly string[];
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly message: string;
  readonly remediation: string;
}

export function degenerateFaceFindings(entity: SubdivisionEntity, size: number): Finding[] {
  const flat = entity.faces.flatMap((face, f) => (faceArea(entity.vertices, face) < 1e-12 * size * size ? [f] : []));
  if (flat.length === 0) return [];
  return [
    {
      code: 'DIR_CHECK_DEGENERATE_FACE',
      severity: 'fail',
      ids: flat.map((f) => entity.elementIds.faces[f] as string),
      value: flat.length,
      limit: 0,
      unit: 'faces',
      message: `${flat.length} cage face(s) have zero area`,
      remediation: 'move or merge the vertices of those faces',
    },
  ];
}

/** The level the self-intersection test ran on (the finest within the triangle budget) and its findings. */
export function selfIntersectionFindings(entity: SubdivisionEntity): { level: number; findings: Finding[] } {
  const findings: Finding[] = [];
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
  return { level, findings };
}

export function symmetryFindings(entity: SubdivisionEntity, deviation: number, limit: number, unit: string): Finding[] {
  if (entity.symmetry === undefined || !(deviation > limit)) return [];
  return [
    {
      code: 'DIR_CHECK_SYMMETRY_DEVIATION',
      severity: 'warn',
      ids: [entity.id],
      value: deviation,
      limit,
      unit,
      message: `the cage deviates ${deviation.toExponential(3)} from its declared mirror symmetry`,
      remediation: 'run set_cage_symmetry with snap true',
    },
  ];
}

/** The volume checks of a closed cage: level mesh against the limit-volume estimate (none for an open surface, which has no volume). */
export function volumeFindings(
  entity: SubdivisionEntity,
  open: boolean,
  meshVolume: number | null,
  estimate: { volume: number; level: number } | null,
  volumeRatio: number | null,
  volumeLimit: number,
): Finding[] {
  if (open) return [];
  if (estimate === null || meshVolume === null)
    return [
      {
        code: 'DIR_CHECK_LIMIT_VOLUME_UNAVAILABLE',
        severity: 'warn',
        ids: [entity.id],
        value: 0,
        limit: 0,
        unit: 'volume',
        message: 'the cage is too large for the limit-volume estimate: the level-mesh deviation was not checked',
        remediation: 'check a coarser cage, or use the exact kernel with exactSeams true (data.limitPatches)',
      },
    ];
  if (volumeRatio === null || !Number.isFinite(volumeRatio))
    return [
      {
        code: 'DIR_CHECK_VOLUME_NON_FINITE',
        severity: 'warn',
        ids: [entity.id],
        value: Number.NaN,
        limit: volumeLimit,
        unit: 'relative',
        message: `the volumes (level mesh ${meshVolume}, limit estimate ${estimate.volume}) cannot be compared`,
        remediation: 'the cage is degenerate or inside out: check the winding and the face areas',
      },
    ];
  if (volumeRatio > volumeLimit)
    return [
      {
        code: 'DIR_CHECK_LEVEL_MESH_DEVIATION',
        severity: 'warn',
        ids: [entity.id],
        value: volumeRatio,
        limit: volumeLimit,
        unit: 'relative',
        message: `the level-${entity.levels} mesh volume ${meshVolume.toPrecision(10)} differs from the limit-surface volume ${estimate.volume.toPrecision(8)}`,
        remediation: 'raise levels, or use the exact kernel (mass_properties then measures the limit patches)',
      },
    ];
  return [];
}

/** The valence histogram of the cage and the info finding for its extraordinary vertices and n-gon faces. */
export function extraordinaryFindings(
  entity: SubdivisionEntity,
  topology: CageTopology,
): { histogram: Record<string, number>; findings: Finding[] } {
  const histogram: Record<string, number> = {};
  const extraordinary: string[] = [];
  (topology.vertexEdges as number[][]).forEach((edges, v) => {
    if (edges.length === 4) return;
    histogram[String(edges.length)] = (histogram[String(edges.length)] ?? 0) + 1;
    extraordinary.push(entity.elementIds.vertices[v] as string);
  });
  const ngons = entity.faces.flatMap((face, f) => (face.length === 4 ? [] : [entity.elementIds.faces[f] as string]));
  if (extraordinary.length === 0 && ngons.length === 0) return { histogram, findings: [] };
  return {
    histogram,
    findings: [
      {
        code: 'DIR_CHECK_EXTRAORDINARY',
        severity: 'info',
        ids: [...extraordinary, ...ngons],
        value: extraordinary.length + ngons.length,
        limit: 0,
        unit: 'elements',
        message: `${extraordinary.length} extraordinary vertex(es), ${ngons.length} n-gon face(s): the limit surface is only G1 there`,
        remediation: 'none needed; a regular quad cage is C2 everywhere',
      },
    ],
  };
}

export function sharpnessBudgetFindings(entity: SubdivisionEntity): Finding[] {
  const budget = settleBudgetProblem(entity);
  if (budget === null) return [];
  return [
    {
      code: 'DIR_SHARPNESS_BUDGET',
      severity: 'warn',
      ids: [entity.id],
      value: fullSettleLevels(entity),
      limit: settleLevels(entity),
      unit: 'levels',
      message: `${budget}: the exact paths (patches, B-spline export, evaluator, code export) read the sharpness left after the budgeted settling as infinite`,
      remediation: 'set_cage_crease with a lower sharpness (or 10 for infinite) so every path describes the level mesh',
    },
  ];
}

/** The seam findings of the exact patches: gap between neighbours and tangent-plane angle against their limits. */
export function patchSeamFindings(
  entity: SubdivisionEntity,
  patches: Record<string, number> | null,
  gapLimit: number,
  angleLimit: number,
  unit: string,
): Finding[] {
  const findings: Finding[] = [];
  if (patches !== null && (patches['maxG0Gap'] as number) > gapLimit)
    findings.push({
      code: 'DIR_CHECK_PATCH_SEAM_GAP',
      severity: 'warn',
      ids: [entity.id],
      value: patches['maxG0Gap'] as number,
      limit: gapLimit,
      unit,
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
  return findings;
}
