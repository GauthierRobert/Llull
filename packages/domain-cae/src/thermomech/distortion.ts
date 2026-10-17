/** thermal_distortion_report (PHY-04 TR-TMC-16, §5.4): flatness of faces before / after the displacement, displacement of named points. */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf } from '../shared/access';
import { analysisLengthMetres } from '../shared/defaults';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { fitPlane } from './plane';
import { refuseTmc } from './refusal';

const faceSchema = z.object({
  name: z.string().min(1).describe('Name of the face in the report, e.g. "mounting face".'),
  targetKey: z
    .string()
    .optional()
    .describe(
      'Key of a mesh node set: C_<constraintId>, L_<loadId>, P_<probeId> ... of a target already in the analysis (use its face as the face).',
    ),
  onPlane: z
    .object({
      entityId: z.string().describe('Id of the analysed solid whose mesh nodes are selected.'),
      point: vec3('A point [x, y, z] in document units on the face plane.'),
      normal: vec3('Face normal [x, y, z] (need not be unit length).'),
      distance: z.number().describe('Select nodes whose distance to the plane is <= this value, in document units (> 0, e.g. 1e-3).'),
    })
    .optional()
    .describe('Alternative to targetKey: the nodes of an entity lying on a plane.'),
  tolerance: z
    .number()
    .optional()
    .describe('Flatness tolerance in document units; when given, the report states whether the deformed face is within it.'),
});

interface Loaded {
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

const lengthFactor = (doc: CadDocument, mesh: FeMeshArtifact): number => analysisLengthMetres(mesh.unitSystem) / toMetres(doc, 1);

/**
 * @invariant read-only; data { unit, maxDisplacement, faces[{ name, nodes, flatnessBefore, flatnessAfter, change, normal, tolerance?, withinTolerance?,
 *   reviewRequired }], points[{ name, nodeId, distance, displacement[3], magnitude }], reviewRequired: true }; lengths in document units
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; unsolved / no artifact / not verifiable on this machine -> FEA_RESULTS_MISSING; stale ->
 *   FEA_RESULTS_STALE; recorded summary that differs from its artifact -> FEA_SUMMARY_MISMATCH; face without a
 *   usable node set (< 3 non-collinear nodes) -> FEA_TARGET_UNRESOLVED; no DISP field -> FEA_RESULTS_MISSING (refusals)
 */
export const thermalDistortionReport = defineCommand({
  name: 'thermal_distortion_report',
  description:
    'Report the distortion of a solved analysis (typically thermo_static): for each face, the flatness (max - min signed distance of its ' +
    'nodes to their least-squares plane) before and after the displacement and the change, optionally against a flatness tolerance; for ' +
    'each named point, the displacement of the nearest node. A face is a mesh node set (targetKey of an existing constraint / load / ' +
    'probe target) or the nodes of a solid lying on a plane (onPlane). Lengths are in document units. Reads the stored results ' +
    'artifact; refused when the results are stale or missing. reviewRequired is always true: it is an engineering number for a ' +
    'qualified reviewer, not a drawing verdict.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    faces: z.array(faceSchema).optional().describe('Faces to measure.'),
    points: z
      .array(
        z.object({
          name: z.string().min(1).describe('Name of the point.'),
          point: vec3('Location [x, y, z] in document units (undeformed).'),
        }),
      )
      .optional()
      .describe('Points whose displacement to report (nearest mesh node).'),
  }),
  run: (doc, { analysisId, faces = [], points = [] }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId]): CommandResult =>
      refuseTmc(doc, 'thermal_distortion_report', code, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
    if (analysisCase.results === undefined || analysisCase.meshSummary === undefined)
      return fail('FEA_RESULTS_MISSING', `analysis '${analysisId}' has no recorded mesh and results (fea_mesh, fea_solve)`);
    const trust = trustedRecord(doc, analysisCase, ctx?.feaArtifacts);
    if (trust.state === 'stale') return fail('FEA_RESULTS_STALE', `the results of '${analysisId}' were computed from different inputs`);
    if (trust.state === 'untrusted')
      return fail('FEA_SUMMARY_MISMATCH', trust.problem?.message ?? 'a recorded summary differs from its artifact');
    const { meshArtifact: mesh, resultsArtifact: results } = trust;
    if (trust.state !== 'solved' || mesh === null || results === null)
      return fail(
        'FEA_RESULTS_MISSING',
        `the mesh or results artifact is not verifiable on this machine: ${trust.problem?.message ?? 'no artifact store'}`,
      );
    const loaded: Loaded = { mesh, results };
    return measure(doc, analysisId, loaded, faces, points, fail);
  },
});

type Failer = (code: string, message: string, ids?: readonly string[]) => CommandResult;
type FaceInput = z.output<typeof faceSchema>;

function faceNodeIds(mesh: FeMeshArtifact, face: FaceInput, factor: number): number[] | string {
  if (face.targetKey !== undefined) {
    const set = Object.hasOwn(mesh.nodeSets, face.targetKey) ? mesh.nodeSets[face.targetKey] : undefined;
    return set === undefined ? `no node set '${face.targetKey}' in the mesh` : [...set];
  }
  const plane = face.onPlane;
  if (plane === undefined) return `face '${face.name}' needs targetKey or onPlane`;
  const length = Math.hypot(...plane.normal);
  if (!(length > 0) || !(plane.distance > 0)) return `face '${face.name}': normal must be non-zero and distance > 0`;
  const unit = plane.normal.map((c) => c / length);
  const entityNodes = new Set<number>();
  for (const block of mesh.blocks)
    if (block.entityId === plane.entityId) for (const element of block.elements) for (const node of element.slice(1)) entityNodes.add(node);
  return mesh.nodes
    .filter(([id, x, y, z]) => {
      if (!entityNodes.has(id)) return false;
      const distance =
        (x * factor - plane.point[0]) * (unit[0] ?? 0) +
        (y * factor - plane.point[1]) * (unit[1] ?? 0) +
        (z * factor - plane.point[2]) * (unit[2] ?? 0);
      return Math.abs(distance) <= plane.distance;
    })
    .map(([id]) => id);
}

function measure(
  doc: CadDocument,
  analysisId: string,
  { mesh, results }: Loaded,
  faces: readonly FaceInput[],
  points: readonly { name: string; point: Vec3 }[],
  fail: Failer,
): CommandResult {
  const step = results.steps[results.steps.length - 1];
  const displacement = step?.fields['DISP'];
  if (displacement === undefined) return fail('FEA_RESULTS_MISSING', 'the results have no DISP field');
  const unit = doc.units;
  const factor = lengthFactor(doc, mesh);
  const position = new Map<number, Vec3>(mesh.nodes.map(([id, x, y, z]) => [id, [x * factor, y * factor, z * factor]]));
  const shift = (id: number): Vec3 => {
    const u = displacement.values[String(id)] ?? [0, 0, 0];
    return [(u[0] ?? 0) * factor, (u[1] ?? 0) * factor, (u[2] ?? 0) * factor];
  };
  const faceRows = [];
  for (const face of faces) {
    const nodeIds = faceNodeIds(mesh, face, factor);
    if (typeof nodeIds === 'string') return fail('FEA_TARGET_UNRESOLVED', nodeIds);
    const before = nodeIds.flatMap((id) => {
      const p = position.get(id);
      return p === undefined ? [] : [p];
    });
    const after = nodeIds.flatMap((id) => {
      const p = position.get(id);
      const u = shift(id);
      return p === undefined ? [] : [[p[0] + u[0], p[1] + u[1], p[2] + u[2]] as Vec3];
    });
    const fitBefore = fitPlane(before);
    const fitAfter = fitPlane(after);
    if (fitBefore === null || fitAfter === null)
      return fail('FEA_TARGET_UNRESOLVED', `face '${face.name}' has ${before.length} node(s); at least 3 non-collinear nodes are needed`);
    faceRows.push({
      name: face.name,
      nodes: before.length,
      flatnessBefore: fitBefore.flatness,
      flatnessAfter: fitAfter.flatness,
      change: fitAfter.flatness - fitBefore.flatness,
      normal: fitBefore.normal,
      ...(face.tolerance !== undefined ? { tolerance: face.tolerance, withinTolerance: fitAfter.flatness <= face.tolerance } : {}),
      reviewRequired: true as const,
    });
  }
  const pointRows = [];
  for (const { name, point } of points) {
    let best = Number.POSITIVE_INFINITY;
    let nodeId = -1;
    for (const [id, p] of position) {
      const distance = Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]);
      if (distance < best) {
        best = distance;
        nodeId = id;
      }
    }
    if (nodeId < 0) return fail('FEA_TARGET_UNRESOLVED', 'the mesh has no nodes');
    const u = shift(nodeId);
    pointRows.push({ name, nodeId, distance: best, displacement: u, magnitude: Math.hypot(...u) });
  }
  let maxDisplacement = 0;
  for (const id of position.keys()) maxDisplacement = Math.max(maxDisplacement, Math.hypot(...shift(id)));
  const text = faceRows
    .map((row) => `${row.name} flatness ${row.flatnessBefore.toPrecision(6)} -> ${row.flatnessAfter.toPrecision(6)} ${unit}`)
    .concat(pointRows.map((row) => `${row.name} |u| ${row.magnitude.toPrecision(6)} ${unit}`))
    .join('; ');
  const exceeding = faceRows.filter((row) => row.withinTolerance === false).length;
  return report(
    doc,
    `thermal_distortion_report: '${analysisId}' max |u| ${maxDisplacement.toPrecision(6)} ${unit}${text === '' ? '' : `; ${text}`}${exceeding > 0 ? `; ${exceeding} face(s) exceed the given flatness tolerance` : ''}; review required.`,
    { analysisId, unit, maxDisplacement, faces: faceRows, points: pointRows, reviewRequired: true },
  );
}
