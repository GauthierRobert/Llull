/**
 * Judges one operating point against the access graph (06 STA §5.7). Candidate surfaces: top at or below the point and within `maxHorizontalReachMm`
 * in plan. The one reported is the best by (1) inside the band and connected to grade, (2) inside the band, (3) connected, (4) any; the highest within a
 * rank, then the lowest id. A point that cannot be judged is a finding, never a pass.
 */

import { remediationOf, type StaCode } from '../../codes';
import type { Finding } from '../finding';
import { distanceToNode } from '../graph/connectors';
import { boxesNear } from '../graph/regions';
import { legsTo, routeIds, type RouteTree } from '../graph/search';
import type { AccessGraph, SurfaceNode } from '../graph/types';
import type { ReachTarget } from './valveTargets';

export interface Band {
  readonly minMm: number;
  readonly maxMm: number;
  readonly source: string;
}

export interface ReachSettings {
  readonly band: Band;
  readonly reachMm: number;
  readonly gradeIsWalkable: boolean;
}

export interface TargetResult {
  readonly tag: string;
  readonly kind: string;
  readonly pointMm: readonly [number, number, number] | null;
  readonly ok: boolean;
  readonly surfaceId: string | null;
  readonly heightAboveSurfaceMm: number | null;
  readonly reachMm: number | null;
  readonly connected: boolean | null;
  readonly route: string[] | null;
  readonly legs: Array<{ kind: string; id: string; from: string; to: string; clearWidthMm: number | null }> | null;
  readonly candidates: number;
  readonly findings: Finding[];
}

/** A point at the same height as a surface top counts as on it (float noise of a unit conversion). */
const SAME_LEVEL_MM = 0.5;

function projectFinding(
  code: StaCode,
  ruleId: string,
  clause: string,
  tag: string,
  ids: string[],
  measured: Finding['measured'],
  limit: Finding['limit'],
  severity: 'fail' | 'warn',
): Finding {
  return {
    code,
    ruleId,
    ruleset: 'project',
    clause,
    severity,
    grade: 'A',
    ids,
    measured,
    limit,
    remediation: remediationOf(code),
    source: clause,
    location: `target ${tag}`,
  };
}

interface Candidate {
  readonly node: SurfaceNode;
  readonly height: number;
  readonly plan: number;
  readonly connected: boolean;
  readonly inBand: boolean;
}

/** Plan distance to the nearest walking surface at or below the point, ignoring the reach (for the STA_REACH finding); Infinity when none. */
function nearestSurfaceBelow(graph: AccessGraph, x: number, y: number, z: number, gradeIsWalkable: boolean): number {
  let nearest = Infinity;
  for (const node of graph.nodes) {
    if (node.topMm > z + SAME_LEVEL_MM || (node.kind === 'grade' && !gradeIsWalkable)) continue;
    nearest = Math.min(nearest, distanceToNode([x, y], node));
  }
  return nearest;
}

export function evaluateTarget(graph: AccessGraph, tree: RouteTree, settings: ReachSettings, target: ReachTarget): TargetResult {
  const { band, reachMm } = settings;
  const empty = {
    tag: target.tag,
    kind: target.kind,
    pointMm: target.pointMm,
    surfaceId: null,
    heightAboveSurfaceMm: null,
    reachMm: null,
    connected: null,
    route: null,
    legs: null,
    candidates: 0,
  };
  if (target.pointMm === null)
    return {
      ...empty,
      ok: false,
      findings: [
        projectFinding(
          'STA_TARGET_UNLOCATED',
          'PROJECT-TARGET-LOCATED',
          `${target.kind} ${target.tag} has no operating point`,
          target.tag,
          [],
          { value: 0, unit: 'operating points' },
          { min: 1, unit: 'operating points' },
          'warn',
        ),
      ],
    };
  const [x, y, z] = target.pointMm;
  const box = [x, y, x, y] as const;
  const candidates: Candidate[] = [];
  for (const node of graph.nodes) {
    if (node.topMm > z + SAME_LEVEL_MM || (node.kind === 'grade' && !settings.gradeIsWalkable)) continue;
    if (node.kind !== 'grade' && !boxesNear(node.box, box, reachMm)) continue;
    const plan = distanceToNode([x, y], node);
    if (plan > reachMm) continue;
    const height = Math.max(0, z - node.topMm);
    candidates.push({
      node,
      height,
      plan,
      connected: tree.via.has(node.id),
      inBand: height >= band.minMm - 1e-6 && height <= band.maxMm + 1e-6,
    });
  }
  const rank = (candidate: Candidate): number => (candidate.inBand ? 0 : 2) + (candidate.connected ? 0 : 1);
  const best = [...candidates].sort((a, b) => rank(a) - rank(b) || b.node.topMm - a.node.topMm || (a.node.id < b.node.id ? -1 : 1))[0];
  if (best === undefined) {
    const nearest = nearestSurfaceBelow(graph, x, y, z, settings.gradeIsWalkable);
    const finding = Number.isFinite(nearest)
      ? projectFinding(
          'STA_REACH',
          'PROJECT-REACH',
          `a walking surface at or below the point within ${reachMm} mm in plan`,
          target.tag,
          [],
          { value: nearest, unit: 'mm in plan to the nearest surface below' },
          { max: reachMm, unit: 'mm' },
          'fail',
        )
      : projectFinding(
          'STA_REACH',
          'PROJECT-REACH',
          'a walking surface at or below the point',
          target.tag,
          [],
          { value: 0, unit: 'walking surfaces at or below the point' },
          { min: 1, unit: 'walking surfaces' },
          'fail',
        );
    return { ...empty, ok: false, findings: [finding] };
  }
  const findings: Finding[] = [];
  if (!best.inBand)
    findings.push(
      projectFinding(
        'STA_OPERATING_HEIGHT',
        'PROJECT-OPERATING-HEIGHT',
        band.source,
        target.tag,
        [best.node.id],
        { value: best.height, unit: 'mm above the surface' },
        { min: band.minMm, max: band.maxMm, unit: 'mm' },
        'fail',
      ),
    );
  if (!best.connected)
    findings.push(
      projectFinding(
        'STA_ACCESS_NO_EGRESS',
        'PROJECT-EGRESS',
        'a walking surface needs a route to grade',
        target.tag,
        [best.node.id],
        { value: 0, unit: 'routes to grade' },
        { min: 1, unit: 'routes to grade' },
        'fail',
      ),
    );
  const legs = legsTo(tree, best.node.id);
  return {
    ...empty,
    ok: findings.length === 0,
    surfaceId: best.node.id,
    heightAboveSurfaceMm: best.height,
    reachMm: best.plan,
    connected: best.connected,
    route: legs === null ? null : routeIds(legs),
    legs:
      legs?.map((leg) => ({ kind: leg.edge.kind, id: leg.edge.id, from: leg.from, to: leg.to, clearWidthMm: leg.edge.clearWidthMm })) ??
      null,
    candidates: candidates.length,
    findings,
  };
}
