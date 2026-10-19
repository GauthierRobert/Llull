/**
 * compute_registration (TECHNICAL_SPEC §4.2, §5.8): sphere / point targets (Horn) and trimmed ICP run natively; the answer is a
 * RegistrationRecord ready for apply_registration. Never changes the document (TR-SCN-04).
 */

import type { CloudReference, Mat4, RegistrationRecord } from '@core/model/pointCloud';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { isSuccess, numberAt, runOp } from './compute';
import { invertAffine, multiply, rotationAngleDeg, translationOf } from './mat4';
import { fromM, toM, vecToM } from './model';
import { cloudIdParam, mat4Param, regionParam } from './schemas';
import { resolveRegion } from './region';

/** Named quality gates (AF-31): target RMS ≤ 3 mm; ICP RMS ≤ 2 × the fixed cloud's median spacing. Above them: warn + unverified. */
export const TARGET_RMS_GATE_M = 0.003;
export const ICP_RMS_SPACING_FACTOR = 2;
/** Below this overlap an ICP result is SCN_REG_NOT_CONVERGED (§5.8). */
export const MIN_OVERLAP = 0.1;

const point = (text: string): z.ZodArray<z.ZodNumber> => z.array(z.number()).length(3).describe(text);

const targetParam = z
  .object({
    name: z.string().describe('Target name, e.g. "T1".'),
    kind: z.enum(['sphere', 'point']).describe('sphere: fitted sphere target near the seeds; point: picked points used as they are.'),
    fixedPoint: point('[x, y, z] seed (sphere) or point in the FIXED cloud, document units.'),
    movingPoint: point('[x, y, z] seed (sphere) or point in the MOVING cloud, document units (its current placement).'),
    radius: z.number().optional().describe('Sphere radius in document units (required for kind sphere), e.g. 72.5.'),
  })
  .describe('One target pair.');

interface Delta {
  readonly transform: Mat4;
  readonly result: Readonly<Record<string, unknown>>;
}

/** The registration record of a document-frame correction `delta` (moving document → fixed document). */
function recordOf(fixed: CloudReference, moving: CloudReference, delta: Mat4): Mat4 {
  const inverse = invertAffine(fixed.transform);
  return inverse === null ? delta : multiply(inverse, multiply(delta, moving.transform));
}

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; same cloud -> SCN_REG_SAME_CLOUD; targets: SCN_REG_TARGETS_INSUFFICIENT, SCN_REG_DEGENERATE,
 *   SCN_REG_TARGET_NOT_FOUND; ICP not converged or overlap < 10 % -> SCN_REG_NOT_CONVERGED (data.record has converged false); no binary ->
 *   NATIVE_TOOL_MISSING
 */
export const computeRegistration = defineCommand({
  name: 'compute_registration',
  description:
    'Read-only: register the MOVING cloud onto the FIXED cloud and return a record for apply_registration. method "targets": >= 3 non-collinear ' +
    'target pairs (sphere targets are segmented within 2 radii of each seed and fitted; Horn closed form) with per-target residuals; ' +
    '"icp_point_to_point" / "icp_point_to_plane": trimmed ICP from `initial` (a record transform, moving -> fixed asset frames) or the current ' +
    'placement; "targets+icp": targets then ICP. Quality gates (named defaults): target RMS <= 3 mm, ICP RMS <= 2 x point spacing, else the ' +
    'record is "unverified". Non-convergence or < 10 % overlap is refused (SCN_REG_NOT_CONVERGED, record in data, never applied). Rotations ' +
    'above ~30 degrees need targets first. Numerics run in the native llull-compute (deterministic, seeded).',
  annotations: { readOnly: true },
  params: z.object({
    fixed: cloudIdParam,
    moving: cloudIdParam,
    method: z.enum(['targets', 'icp_point_to_point', 'icp_point_to_plane', 'targets+icp']).describe('Registration method.'),
    targets: z.array(targetParam).optional().describe('Target pairs for "targets" / "targets+icp".'),
    initial: mat4Param.optional(),
    region: regionParam.optional(),
    maxIterations: z.number().int().positive().optional().describe('ICP iteration cap (default 100).'),
    trimRatio: z.number().optional().describe('ICP trimming: fraction of the closest pairs kept, (0, 1] (default 0.9).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const {
      fixed: fixedId,
      moving: movingId,
      method,
      targets = [],
      initial,
      region = { kind: 'all' as const },
      maxIterations = 100,
      trimRatio = 0.9,
    } = params;
    const command = 'compute_registration';
    if (fixedId === movingId)
      return refuseScan(doc, command, 'SCN_REG_SAME_CLOUD', 'fixed and moving are the same cloud', [fixedId], ['moving']);
    const fixedAccess = cloudAccess(doc, command, fixedId, ctx, 'fixed');
    if (!isAccess(fixedAccess)) return fixedAccess;
    const movingAccess = cloudAccess(doc, command, movingId, ctx, 'moving');
    if (!isAccess(movingAccess)) return movingAccess;
    if (!(trimRatio > 0 && trimRatio <= 1))
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'trimRatio must be in (0, 1]', [], ['trimRatio']);
    const resolved = resolveRegion(doc, region);
    if (!resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [fixedId, movingId], ['region']);
    const { port } = fixedAccess;
    const [fixed, moving] = [fixedAccess.cloud, movingAccess.cloud];
    const clouds = [fixed, moving];
    const usesTargets = method === 'targets' || method === 'targets+icp';
    let delta: Delta | null = null;
    let targetResult: Readonly<Record<string, unknown>> | null = null;
    let provenance = { device: 'cpu' as 'cpu' | 'gpu', deterministic: true, binary: '' };
    if (usesTargets) {
      if (targets.some((t) => t.kind === 'sphere' && !(t.radius !== undefined && t.radius > 0)))
        return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'a sphere target needs radius > 0', [], ['targets']);
      const ran = runOp(doc, command, port, 'register_targets', clouds, {
        targets: targets.map((t) => ({
          name: t.name,
          kind: t.kind,
          fixed: vecToM(doc, t.fixedPoint),
          moving: vecToM(doc, t.movingPoint),
          ...(t.radius !== undefined ? { radius: toM(doc, t.radius) } : {}),
        })),
      });
      if (!isSuccess(ran)) return ran;
      targetResult = ran.result;
      provenance = { ...ran.provenance };
      delta = { transform: ran.result['transform'] as Mat4, result: ran.result };
    }
    let icpResult: Readonly<Record<string, unknown>> | null = null;
    if (method !== 'targets') {
      const movingInverse = invertAffine(moving.transform);
      const start: Mat4 | null =
        delta?.transform ??
        (initial !== undefined && movingInverse !== null ? multiply(fixed.transform, multiply(initial, movingInverse)) : null);
      const ran = runOp(doc, command, port, 'icp', clouds, {
        method: method === 'icp_point_to_plane' ? 'point_to_plane' : 'point_to_point',
        maxIterations,
        trimRatio,
        region: resolved.region,
        ...(start !== null ? { initial: start } : {}),
      });
      if (!isSuccess(ran)) return ran;
      icpResult = ran.result;
      provenance = { ...ran.provenance };
      delta = { transform: ran.result['transform'] as Mat4, result: ran.result };
    }
    if (delta === null) return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'no registration ran', []);
    const transform = recordOf(fixed, moving, delta.transform);
    const targetRms = targetResult === null ? null : numberAt(targetResult, 'rms');
    const icpRms = icpResult === null ? null : numberAt(icpResult, 'rms');
    const spacing = icpResult === null ? null : numberAt(icpResult, 'fixedSpacing');
    const overlap = icpResult === null ? undefined : numberAt(icpResult, 'overlap');
    const converged = icpResult === null ? true : icpResult['converged'] === true && (overlap ?? 1) >= MIN_OVERLAP;
    const gates = {
      targetRmsM: { value: TARGET_RMS_GATE_M, source: 'TECHNICAL_SPEC §5.8 named default (AF-31)', defaulted: true },
      icpRmsSpacingFactor: { value: ICP_RMS_SPACING_FACTOR, source: 'TECHNICAL_SPEC §5.8 named default (AF-31)', defaulted: true },
    };
    const exceeded = [
      ...(targetRms !== null && targetRms > TARGET_RMS_GATE_M
        ? [`target RMS ${fromM(doc, targetRms).toPrecision(4)} ${doc.units} above 3 mm`]
        : []),
      ...(icpRms !== null && spacing !== null && icpRms > ICP_RMS_SPACING_FACTOR * spacing ? ['ICP RMS above 2 x the point spacing'] : []),
    ];
    const residuals = ((targetResult?.['targets'] as { name: string; residual: number }[] | undefined) ?? []).map((t) => ({
      name: t.name,
      residual: t.residual,
    }));
    const record: Omit<RegistrationRecord, 'id'> = {
      fixed: fixedId,
      moving: movingId,
      method,
      transform,
      quality: {
        ...(residuals.length > 0 ? { targetResiduals: residuals } : {}),
        rms: icpRms ?? targetRms ?? 0,
        ...(overlap !== undefined ? { overlap } : {}),
        ...(icpResult !== null ? { iterations: numberAt(icpResult, 'iterations') } : {}),
        converged,
      },
      status: exceeded.length > 0 ? 'unverified' : 'computed',
      provenance: {
        method,
        algorithmVersion: `${provenance.binary || 'llull-compute'}/register-1`,
        device: provenance.device,
        deterministic: provenance.deterministic,
      },
    };
    const data = {
      record,
      quality: record.quality,
      rotationDeg: rotationAngleDeg(transform),
      translation: translationOf(transform).map((v) => fromM(doc, v)),
      unit: doc.units,
      gates,
      warnings: exceeded.map((message) => ({ code: 'SCN_REGISTRATION_UNVERIFIED', message })),
      ...(targetResult !== null ? { targets: targetResult['targets'] } : {}),
    };
    if (!converged)
      return {
        ...refuseScan(
          doc,
          command,
          'SCN_REG_NOT_CONVERGED',
          `ICP did not converge or the overlap is below ${MIN_OVERLAP * 100} % (overlap ${((overlap ?? 0) * 100).toFixed(1)} %)`,
          [fixedId, movingId],
        ),
        data,
      };
    const rmsText = `${fromM(doc, record.quality?.rms ?? 0).toPrecision(4)} ${doc.units}`;
    return report(
      doc,
      `Registration ${movingId} -> ${fixedId} (${method}): rotation ${data.rotationDeg.toFixed(4)} deg, RMS ${rmsText}, status ${record.status}${exceeded.length > 0 ? ` (${exceeded.join('; ')})` : ''}. Apply with apply_registration record=<data.record>.`,
      data,
    );
  },
});
