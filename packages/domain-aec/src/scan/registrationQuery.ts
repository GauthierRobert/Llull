/**
 * compute_registration (TECHNICAL_SPEC §4.2, §5.8): sphere / point targets (Horn) and trimmed ICP run natively; the answer is a
 * RegistrationRecord ready for apply_registration. Never changes the document (TR-SCN-04).
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { type Registration, icpStage, isRefusal, registrationReport, targetStage } from './registrationPhases';
import { cloudIdParam, mat4Param, regionParam } from './schemas';
import { resolveRegion } from './region';

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
    let registered: Registration = {
      delta: null,
      targetResult: null,
      icpResult: null,
      provenance: { device: 'cpu', deterministic: true, binary: '' },
    };
    if (method === 'targets' || method === 'targets+icp') {
      const staged = targetStage(doc, port, [fixed, moving], targets);
      if (isRefusal(staged)) return staged;
      registered = staged;
    }
    if (method !== 'targets') {
      const staged = icpStage(doc, port, fixed, moving, { method, initial, maxIterations, trimRatio, region: resolved.region }, registered);
      if (isRefusal(staged)) return staged;
      registered = staged;
    }
    if (registered.delta === null) return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'no registration ran', []);
    return registrationReport(doc, { fixedId, movingId }, method, fixed, moving, registered.delta, registered);
  },
});
