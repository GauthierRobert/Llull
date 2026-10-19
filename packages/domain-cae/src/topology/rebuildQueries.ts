/** suggest_rebuild / compare_to_topology: turn a recorded topology result into modelling input and judge a rebuilt solid against it (TR-TOP-09/10). */

import type { FeArtifactPort } from '@core/model/analysis';
import type { NamedValue, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { toMm } from '@core/model/units';
import { significantNumber } from '@lib/compactNumber';
import { refuseTopology } from './codes';
import { COMPLIANCE_RATIO_TARGET, IOU_TARGET, MIN_LOOP_AREA_VOXELS } from './defaults';
import { symmetrise } from './derive';
import { findStudy } from './model';
import { rebuildCompliance } from './rebuildCompliance';
import { compareRebuild, contoursOf, mm2PerUnit2, placementOf, sectionOf } from './rebuild';
import { widthSamples } from './widthSamples';
import { studyIdSchema } from './schemas';
import { trustedTopology, type TrustedTopology } from './trust';

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** A solved, trusted study with its field, or the refusal a query returns instead. */
function solvedStudy(
  doc: CadDocument,
  command: string,
  studyId: string,
  port: FeArtifactPort | null | undefined,
):
  | {
      readonly study: TopologyStudy;
      readonly trusted: TrustedTopology & { readonly field: Float32Array; readonly artifact: NonNullable<TrustedTopology['artifact']> };
    }
  | CommandResult {
  const found = findStudy(doc, studyId);
  if (found === undefined) return refuseTopology(doc, command, 'TOP_STUDY_NOT_FOUND', `no topology study '${studyId}'`, [studyId]);
  const result = trustedTopology(doc, found.study, port);
  if (result.state === 'stale')
    return refuseTopology(doc, command, 'TOP_RESULT_STALE', `study ${studyId} changed after its last solve`, [studyId]);
  if (result.state === 'untrusted')
    return refuseTopology(
      doc,
      command,
      'TOP_SUMMARY_MISMATCH',
      result.problem?.message ?? 'the recorded result differs from its artifact',
      [studyId],
    );
  if (result.state !== 'solved' || result.artifact === null || result.field === null)
    return refuseTopology(doc, command, 'TOP_RESULT_MISSING', `study ${studyId} has no verified result (state ${result.state})`, [studyId]);
  return { study: found.study, trusted: { ...result, field: result.field, artifact: result.artifact } };
}

const isRefusal = (value: unknown): value is CommandResult => typeof value === 'object' && value !== null && 'document' in value;

/**
 * @invariant read-only; contours are closed loops of the density field at `threshold`, outer loops counter-clockwise, holes clockwise, simplified
 *   (Douglas-Peucker) to within `tolerance` and without loops smaller than `minLoopArea`; points are the plane-local [x, y] of `extrude_profile`
 *   `widthSamples` = medial-axis nodes of the thresholded section with width = 2 x distance to the void
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; stale -> TOP_RESULT_STALE; unsolved / missing -> TOP_RESULT_MISSING; plane other than a 2D study's
 *   own -> TOP_SETUP_INVALID (rejected no-ops)
 */
export const suggestRebuild = defineCommand({
  name: 'suggest_rebuild',
  annotations: { readOnly: true },
  description:
    'Closed 2D loops that outline the optimized layout of a solved topology study, ready for the rebuild: model the outer loop with ' +
    'extrude_profile (profile = its points, depth = thickness, position / rotation from `placement`), each hole loop with extrude_profile + boolean ' +
    'subtract, round sharp re-entrant corners with fillet_edge, analyse the rebuilt part (05), then compare_to_topology. A 2D study uses its own ' +
    'plane; for a 3D study give `plane` (XY | XZ | YZ) and `offset`, the coordinate of the section along the plane normal (default the middle of ' +
    'the grid). Loops are in document units; `tolerance` (default one voxel) is the largest deviation of the simplification, `minLoopArea` ' +
    '(default 4 voxel^2, document units^2) drops specks (counted in droppedLoops). widthSamples lists member widths on the medial axis of the section: { at: plane-local [x, y], width (document units), widthMm }, widest first, from an exact distance transform. The loops are a suggestion from a concept result, to be reviewed.',
  params: z.object({
    studyId: studyIdSchema,
    plane: z.enum(['XY', 'XZ', 'YZ']).optional().describe('Section plane of a 3D study (default XY). A 2D study uses its own plane.'),
    offset: z
      .number()
      .optional()
      .describe('3D only: coordinate of the section plane along its normal, document units. Default the middle of the grid.'),
    tolerance: z
      .number()
      .optional()
      .describe('Largest deviation of the simplified loops from the field contour, document units, > 0. Default one voxel.'),
    minLoopArea: z.number().optional().describe('Loops with a smaller area are dropped, document units squared, >= 0. Default 4 voxel^2.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const solved = solvedStudy(doc, 'suggest_rebuild', params.studyId, ctx?.feaArtifacts);
    if (isRefusal(solved)) return solved;
    const { study, trusted } = solved;
    const { artifact } = trusted;
    const tolerance = params.tolerance ?? study.voxel;
    const minArea = params.minLoopArea ?? MIN_LOOP_AREA_VOXELS * study.voxel ** 2;
    if (!(tolerance > 0) || !(minArea >= 0))
      return refuseTopology(doc, 'suggest_rebuild', 'TOP_SETUP_INVALID', 'tolerance must be > 0 and minLoopArea >= 0', [params.studyId]);
    const symmetric = symmetrise(trusted.field, artifact.grid, study.manufacturing.symmetry);
    const section = sectionOf(artifact, symmetric, params.plane, params.offset);
    if (typeof section === 'string') return refuseTopology(doc, 'suggest_rebuild', 'TOP_SETUP_INVALID', section, [params.studyId]);
    const { contours, dropped } = contoursOf(section, study.settings.threshold.value, tolerance, minArea);
    const factor = mm2PerUnit2(doc);
    const exact = contoursOf(section, study.settings.threshold.value, 0, 0).contours;
    const outer = exact.filter((contour) => contour.area > 0).reduce((sum, contour) => sum + contour.area, 0);
    const holes = exact.filter((contour) => contour.area < 0).reduce((sum, contour) => sum - contour.area, 0);
    const depth = artifact.grid.dimension === 2 ? artifact.grid.thickness : null;
    const data = {
      plane: section.plane,
      lengthUnit: doc.units,
      placement: { ...placementOf(section, depth), depth },
      loops: contours.map((contour) => ({
        points: contour.points.map((point) => [round(point[0]), round(point[1])]),
        orientation: contour.area > 0 ? 'outer' : 'hole',
        area: round(Math.abs(contour.area)),
        areaMm2: round(Math.abs(contour.area) * factor),
      })),
      droppedLoops: dropped,
      widthSamples: widthSamples(
        section,
        study.settings.threshold.value,
        exact.map((contour) => contour.points),
      ).map((sample) => ({
        at: [round(sample.at[0]), round(sample.at[1])],
        width: round(sample.width),
        widthMm: round(sample.width * toMm(doc, 1)),
      })),
      enclosedFraction: section.domainArea > 0 ? (outer - holes) / section.domainArea : 0,
      threshold: study.settings.threshold.value,
      tolerance,
      minLoopArea: minArea,
      concept: true,
      reviewRequired: true,
    };
    return report(
      doc,
      `suggest_rebuild: ${params.studyId} section ${section.plane} — ${contours.filter((c) => c.area > 0).length} outer loop(s), ${contours.filter((c) => c.area < 0).length} hole(s), ${dropped} dropped, enclosed fraction ${significantNumber(data.enclosedFraction, 4)} of the section (threshold ${study.settings.threshold.value}, tolerance ${significantNumber(tolerance, 4)} ${doc.units}).`,
      data,
    );
  },
});

const target = (given: number | undefined, fallback: NamedValue): NamedValue =>
  given === undefined ? fallback : { value: given, source: 'caller', defaulted: false };

/**
 * @invariant read-only; IoU = |A and B| / |A or B| of the rebuilt voxels A (inside the solid and the design domain) and the thresholded field B on the
 *   study grid; compliance ratio = F^T u of the rebuild (current, artifact-verified 05 static result, force loads) / compliance of the optimum, both in N*mm;
 *   without such a result the ratio is null with complianceStatus.reason (TOP_REBUILD_NOT_ANALYSED); a ratio above complianceRatioTarget is TOP_REBUILD_DEVIATION
 * @failure unknown study / entity not a solid / stale or missing result -> a coded rejected no-op
 */
export const compareToTopology = defineCommand({
  name: 'compare_to_topology',
  annotations: { readOnly: true },
  description:
    'Compare a rebuilt solid with the optimum of a solved topology study: both are voxelised on the study grid; iou = shared voxels / union voxels of ' +
    'the rebuilt solid (inside the design domain) and the optimum (density at or above the threshold), volumeRatio = rebuilt / optimum volume. ' +
    'complianceRatio = F^T u of the rebuild / compliance of the optimum (both in N*mm), from the current 05 static results of an analysis that has ' +
    'the solid as a part (nodal force loads; the recorded results must verify against their artifacts and not be stale); it is null with ' +
    'complianceStatus.reason and the code TOP_REBUILD_NOT_ANALYSED when there is no such result (analyse the rebuild with 05, then compare again). ' +
    'status is pass when iou reaches iouTarget (default 0.85, a llull choice still to be calibrated) and the compliance ratio is within ' +
    'complianceRatioTarget (default 1.15); fail (TOP_REBUILD_DEVIATION) when either is missed; warn when the compliance ratio is unavailable. ' +
    'The result is a review aid: reviewRequired is always true.',
  params: z.object({
    studyId: studyIdSchema,
    entityId: z
      .string()
      .describe('Id of the rebuilt 3D solid (e.g. the extrusion made from the suggest_rebuild loops, after boolean and fillets).'),
    iouTarget: z.number().optional().describe('Required IoU in (0, 1]. Default 0.85 (llull choice, to be calibrated).'),
    complianceRatioTarget: z
      .number()
      .optional()
      .describe('Allowed rebuild / optimum compliance ratio, >= 1. Default 1.15 (llull choice).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const solved = solvedStudy(doc, 'compare_to_topology', params.studyId, ctx?.feaArtifacts);
    if (isRefusal(solved)) return solved;
    const { study, trusted } = solved;
    const iouTarget = target(params.iouTarget, IOU_TARGET);
    if (!(iouTarget.value > 0 && iouTarget.value <= 1))
      return refuseTopology(doc, 'compare_to_topology', 'TOP_SETUP_INVALID', `iouTarget ${iouTarget.value} must be in (0, 1]`, [
        params.studyId,
      ]);
    const comparison = compareRebuild(doc, study, trusted.artifact, trusted.field, params.entityId);
    if (typeof comparison === 'string')
      return refuseTopology(doc, 'compare_to_topology', 'TOP_DOMAIN_INVALID', comparison, [params.entityId]);
    const complianceTarget = target(params.complianceRatioTarget, COMPLIANCE_RATIO_TARGET);
    if (!(complianceTarget.value >= 1) || !Number.isFinite(complianceTarget.value))
      return refuseTopology(
        doc,
        'compare_to_topology',
        'TOP_SETUP_INVALID',
        `complianceRatioTarget ${complianceTarget.value} must be a finite number >= 1`,
        [params.studyId],
      );
    const compliance = rebuildCompliance(
      doc,
      study,
      trusted.artifact.compliance,
      Object.keys(trusted.artifact.perLoadCase),
      params.entityId,
      ctx?.feaArtifacts,
    );
    const iouPassed = comparison.iou >= iouTarget.value;
    const compliancePassed = compliance.available && compliance.ratio <= complianceTarget.value;
    const codes = [
      ...(iouPassed && (!compliance.available || compliancePassed) ? [] : ['TOP_REBUILD_DEVIATION']),
      ...(compliance.available ? [] : ['TOP_REBUILD_NOT_ANALYSED']),
    ];
    const status = !iouPassed || (compliance.available && !compliancePassed) ? 'fail' : compliance.available ? 'pass' : 'warn';
    const data = {
      iou: comparison.iou,
      volumeRatio: comparison.volumeRatio,
      complianceRatio: compliance.available ? compliance.ratio : null,
      complianceStatus: compliance.available
        ? {
            available: true,
            analysisId: compliance.analysisId,
            rebuildCompliance: compliance.rebuildNmm,
            optimumCompliance: compliance.optimumNmm,
            unit: 'N*mm',
          }
        : { available: false, code: compliance.code, reason: compliance.reason, message: compliance.message },
      rebuildVoxels: comparison.rebuildVoxels,
      optimumVoxels: comparison.optimumVoxels,
      targets: { iou: iouTarget, complianceRatio: complianceTarget },
      status,
      codes,
      reviewRequired: true,
    };
    return report(
      doc,
      `compare_to_topology: ${params.entityId} vs ${params.studyId} — iou ${significantNumber(comparison.iou, 4)} (target ${iouTarget.value}), volume ratio ${comparison.volumeRatio === null ? 'n/a' : significantNumber(comparison.volumeRatio, 4)}; ${iouPassed ? 'IoU target reached' : 'IoU below target'}; ${compliance.available ? `compliance ratio ${significantNumber(compliance.ratio, 4)} (target ${complianceTarget.value}, analysis ${compliance.analysisId})${compliancePassed ? '' : ' TOP_REBUILD_DEVIATION'}` : `compliance ratio unavailable (TOP_REBUILD_NOT_ANALYSED: ${compliance.message})`}${codes.includes('TOP_REBUILD_DEVIATION') ? '; TOP_REBUILD_DEVIATION' : ''}; review required.`,
      data,
    );
  },
});
