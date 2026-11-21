/**
 * Branches of `auto_route_lines` (02 RTE §13.17): after the header lines are routed, each branch is taken off its header with the `add_branch`
 * derivation (the tee / olet / stub-in of the header spec's branch table), in the same transaction. Pure; a branch that cannot be placed is an
 * outcome (`RTE_AUTOROUTE_BRANCH_UNREACHABLE` + the `add_branch` code under it), never an exception.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { sub3 } from '@lib/vec3';
import type { PipeRun } from '@aec/plant/types';
import { deriveRun } from '../routeParts';
import { addBranch } from '../commands/addBranch';
import { getPiping } from '../model';
import type { LineOutcome } from './lines';

export type BranchAt = { point: [number, number, number] } | { leg: number; distance: number } | { nearTo: [number, number, number] };

export interface BranchRequest {
  readonly lineId: string;
  readonly headerLineId: string;
  readonly at: BranchAt;
  readonly dn?: number | undefined;
  readonly angleToleranceDeg?: number | undefined;
  readonly to?: Parameters<typeof addBranch.run>[1]['to'];
  readonly legs?: Parameters<typeof addBranch.run>[1]['legs'];
  readonly via?: Parameters<typeof addBranch.run>[1]['via'];
}

export interface BranchOutcome {
  readonly lineId: string;
  readonly headerLineId: string;
  readonly status: 'routed' | 'failed' | 'skipped';
  readonly runId?: string;
  readonly branchId?: string;
  readonly headerRunId?: string;
  readonly fitting?: string;
  readonly code?: string;
  readonly message?: string;
}

/**
 * The leg and distance of the point of the header's straight pipe nearest to `target`. Only the derived pipe pieces count: the ends of a leg
 * belong to elbows, flange sets and port faces, so a target beyond the header end, or off a corner, is clamped to the nearest piece end.
 * @failure no pipe piece of positive length (header not derivable) -> null
 */
function nearest(doc: CadDocument, run: PipeRun, target: Vec3): { leg: number; distance: number; clamped: boolean } | null {
  const derived = deriveRun(doc, run);
  if (!derived.ok) return null;
  let best: { leg: number; distance: number; gap: number; clamped: boolean } | null = null;
  for (const part of derived.parts) {
    const [first, second] = part.ports;
    const origin = part.leg === undefined ? undefined : derived.legs[part.leg]?.start;
    if (part.kind !== 'pipe' || first === undefined || second === undefined || origin === undefined) continue;
    const axis = sub3(second.position, first.position);
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(length > 0)) continue;
    const offset = sub3(target, first.position);
    const raw = (offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]) / length;
    const along = Math.min(Math.max(raw, 0), length);
    const foot: Vec3 = [
      first.position[0] + (axis[0] / length) * along,
      first.position[1] + (axis[1] / length) * along,
      first.position[2] + (axis[2] / length) * along,
    ];
    const delta = sub3(target, foot);
    const gap = Math.hypot(delta[0], delta[1], delta[2]);
    if (best === null || gap < best.gap - 1e-9) {
      const fromStart = sub3(foot, origin);
      best = { leg: part.leg as number, distance: Math.hypot(fromStart[0], fromStart[1], fromStart[2]), gap, clamped: along !== raw };
    }
  }
  return best === null ? null : { leg: best.leg, distance: best.distance, clamped: best.clamped };
}

const skipped = (request: BranchRequest, code: string, message: string): BranchOutcome => ({
  lineId: request.lineId,
  headerLineId: request.headerLineId,
  status: 'skipped',
  code,
  message,
});

/**
 * Takes every branch off its (already routed) header, in request order, on the document the header lines were routed in.
 * @failure header line not routed -> skipped; no leg near `nearTo`, or any add_branch refusal -> failed RTE_AUTOROUTE_BRANCH_UNREACHABLE (the add_branch code in the message)
 */
export function applyBranches(
  doc: CadDocument,
  branches: readonly BranchRequest[],
  headers: readonly LineOutcome[],
): { document: CadDocument; outcomes: BranchOutcome[] } {
  let current = doc;
  const outcomes: BranchOutcome[] = [];
  for (const branch of branches) {
    const header = headers.find((outcome) => outcome.lineId === branch.headerLineId);
    const headerRunId = header?.status === 'routed' ? header.runId : undefined;
    if (headerRunId === undefined) {
      outcomes.push(skipped(branch, 'RTE_AUTOROUTE_BRANCH_UNREACHABLE', `header line ${branch.headerLineId} was not routed`));
      continue;
    }
    const failedWith = (message: string): BranchOutcome => ({
      lineId: branch.lineId,
      headerLineId: branch.headerLineId,
      status: 'failed',
      code: 'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
      message,
    });
    const found = 'nearTo' in branch.at ? nearest(current, getPiping(current).runs[headerRunId] as PipeRun, branch.at.nearTo) : null;
    if ('nearTo' in branch.at && found === null) {
      outcomes.push(failedWith(`header run ${headerRunId} has no straight pipe piece to branch from (nearTo falls on its fittings)`));
      continue;
    }
    const at = found === null ? (branch.at as { point: [number, number, number] } | { leg: number; distance: number }) : found;
    const dn = branch.dn ?? getPiping(current).lines[branch.lineId]?.dn;
    if (dn === undefined) {
      outcomes.push(failedWith(`no pipe line "${branch.lineId}" to take the size from (give dn)`));
      continue;
    }
    const built = {
      runId: headerRunId,
      at: 'distance' in at ? { leg: at.leg, distance: at.distance } : at,
      dn,
      lineId: branch.lineId,
      ...(branch.angleToleranceDeg === undefined ? {} : { angleToleranceDeg: branch.angleToleranceDeg }),
      ...(branch.to === undefined ? {} : { to: branch.to }),
      ...(branch.legs === undefined ? {} : { legs: branch.legs }),
      ...(branch.via === undefined ? {} : { via: branch.via }),
    };
    const clamp =
      found?.clamped === true ? ' (nearTo was clamped to the straight pipe: it lies beyond the header end or on a fitting)' : '';
    const valid = addBranch.paramsValidator?.safeParse(built);
    if (valid !== undefined && !valid.success) {
      outcomes.push(
        failedWith(
          `invalid branch params: ${valid.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}${clamp}`,
        ),
      );
      continue;
    }
    const result = addBranch.run(current, built);
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (result.rejected === true) {
      outcomes.push(
        failedWith(`branch cannot reach header run ${headerRunId}: ${result.error?.code ?? 'add_branch'}: ${result.summary}${clamp}`),
      );
      continue;
    }
    current = result.document;
    outcomes.push({
      lineId: branch.lineId,
      headerLineId: branch.headerLineId,
      status: 'routed',
      runId: result.affected[0] as string,
      branchId: result.affected[1] as string,
      headerRunId,
      fitting: String(data['fitting']),
    });
  }
  return { document: current, outcomes };
}
