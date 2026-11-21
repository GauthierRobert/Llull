/**
 * Branches of `auto_route_lines` (02 RTE §13.17): after the header lines are routed, each branch is taken off its header with the `add_branch`
 * derivation (the tee / olet / stub-in of the header spec's branch table), in the same transaction. Pure; a branch that cannot be placed is an
 * outcome (`RTE_AUTOROUTE_BRANCH_UNREACHABLE` + the `add_branch` code under it), never an exception.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { sub3 } from '@lib/vec3';
import { addBranch } from '../commands/addBranch';
import { getPiping, runPoints } from '../model';
import type { LineOutcome } from './lines';

export type BranchAt = { point: [number, number, number] } | { leg: number; distance: number } | { nearTo: [number, number, number] };

export interface BranchRequest {
  readonly lineId: string;
  readonly headerLineId: string;
  readonly at: BranchAt;
  readonly dn?: number | undefined;
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

/** The leg and distance of the point of the header centreline nearest to `target`, clamped inside its leg (add_branch refuses a point on a fitting). */
function nearest(points: readonly Vec3[], target: Vec3): { leg: number; distance: number } | null {
  let best: { leg: number; distance: number; gap: number } | null = null;
  for (let leg = 0; leg + 1 < points.length; leg++) {
    const [a, b] = [points[leg] as Vec3, points[leg + 1] as Vec3];
    const axis = sub3(b, a);
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(length > 0)) continue;
    const offset = sub3(target, a);
    const raw = (offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]) / length;
    const distance = Math.min(Math.max(raw, 0), length);
    const foot: Vec3 = [a[0] + (axis[0] / length) * distance, a[1] + (axis[1] / length) * distance, a[2] + (axis[2] / length) * distance];
    const delta = sub3(target, foot);
    const gap = Math.hypot(delta[0], delta[1], delta[2]);
    if (best === null || gap < best.gap - 1e-9) best = { leg, distance, gap };
  }
  return best === null ? null : { leg: best.leg, distance: best.distance };
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
    const headerRun = headerRunId === undefined ? undefined : getPiping(current).runs[headerRunId];
    if (headerRunId === undefined || headerRun === undefined) {
      outcomes.push(skipped(branch, 'RTE_AUTOROUTE_BRANCH_UNREACHABLE', `header line ${branch.headerLineId} was not routed`));
      continue;
    }
    const at = 'nearTo' in branch.at ? nearest(runPoints(headerRun), branch.at.nearTo) : branch.at;
    const dn = branch.dn ?? getPiping(current).lines[branch.lineId]?.dn;
    if (at === null || dn === undefined) {
      outcomes.push({
        lineId: branch.lineId,
        headerLineId: branch.headerLineId,
        status: 'failed',
        code: 'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
        message:
          at === null
            ? `header run ${headerRunId} has no leg near the branch`
            : `no pipe line "${branch.lineId}" to take the size from (give dn)`,
      });
      continue;
    }
    const result = addBranch.run(current, {
      runId: headerRunId,
      at,
      dn,
      lineId: branch.lineId,
      ...(branch.to === undefined ? {} : { to: branch.to }),
      ...(branch.legs === undefined ? {} : { legs: branch.legs }),
      ...(branch.via === undefined ? {} : { via: branch.via }),
    });
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (result.rejected === true) {
      outcomes.push({
        lineId: branch.lineId,
        headerLineId: branch.headerLineId,
        status: 'failed',
        code: 'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
        message: `branch cannot reach header run ${headerRunId}: ${result.error?.code ?? 'add_branch'}: ${result.summary}`,
      });
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
