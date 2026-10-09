/**
 * Drainage network analysis: plan geometry, flow accumulation down the pipe DAG and per-pipe /
 * per-manhole design checks (SI units in the result rows).
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel, ManholeObject, PipeObject } from '@core/model/civil';
import { toMetres, toMm } from '../model';
import { civilObjectsOf, civilObject } from './model';
import { manningFullFlow, rationalFlowLps, solvePartialFlow } from './hydraulics';

export interface DrainageCriteria {
  readonly rainfallIntensityMmH: number;
  readonly minVelocity: number;
  readonly maxVelocity: number;
  readonly minCoverM: number;
  readonly maxDepthRatio: number;
}

export const DEFAULT_CRITERIA: DrainageCriteria = {
  rainfallIntensityMmH: 50,
  minVelocity: 0.6,
  maxVelocity: 3,
  minCoverM: 0.9,
  maxDepthRatio: 0.8,
};

export interface PipeRow {
  readonly id: string;
  readonly name: string;
  readonly fromId: string;
  readonly toId: string;
  readonly lengthM: number;
  readonly slopePct: number;
  readonly diameterMm: number;
  readonly material: string;
  readonly designLps: number;
  readonly fullLps: number;
  readonly utilisation: number;
  readonly depthRatio: number;
  readonly velocity: number;
  readonly coverFromM: number;
  readonly coverToM: number;
  readonly status: 'pass' | 'fail';
  readonly reasons: string[];
}

export interface ManholeRow {
  readonly id: string;
  readonly name: string;
  readonly depthM: number;
  readonly dropM: number | null;
  readonly localLps: number;
  readonly status: 'pass' | 'fail';
  readonly reasons: string[];
}

/** Plan distance between a pipe's two structures in document units; null when an end is missing. */
export function pipePlanLength(civil: CivilModel, pipe: PipeObject): number | null {
  const from = civilObject(civil, pipe.fromId, 'manhole');
  const to = civilObject(civil, pipe.toId, 'manhole');
  if (!from || !to) return null;
  return Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1]);
}

/** Slope (drop per plan length, dimensionless); negative when adverse. */
export function pipeSlope(civil: CivilModel, pipe: PipeObject): number {
  const length = pipePlanLength(civil, pipe);
  return length !== null && length > 0 ? (pipe.invertFrom - pipe.invertTo) / length : 0;
}

/** Runoff plus point inflow generated at a manhole itself (L/s). */
export function localFlowLps(manhole: ManholeObject, intensityMmH: number): number {
  const runoff = manhole.catchment
    ? rationalFlowLps(manhole.catchment.runoffCoefficient, intensityMmH, manhole.catchment.areaHa)
    : 0;
  return runoff + (manhole.inflow ?? 0);
}

/** True when a path of pipes leads from `startId` to `targetId`. */
export function flowsTo(civil: CivilModel, startId: string, targetId: string): boolean {
  const pipes = civilObjectsOf(civil, 'pipe');
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop() ?? '';
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const pipe of pipes) if (pipe.fromId === current) stack.push(pipe.toId);
  }
  return false;
}

/** Design flow (L/s) carried by each pipe: every upstream manhole's local flow, accumulated. */
export function pipeDesignFlows(civil: CivilModel, intensityMmH: number): Map<string, number> {
  const pipes = civilObjectsOf(civil, 'pipe');
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const nodeTotal = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const manhole = civilObject(civil, id, 'manhole');
    if (!manhole || visiting.has(id)) return 0;
    visiting.add(id);
    let total = localFlowLps(manhole, intensityMmH);
    for (const pipe of pipes) if (pipe.toId === id) total += nodeTotal(pipe.fromId);
    visiting.delete(id);
    memo.set(id, total);
    return total;
  };
  return new Map(pipes.map((pipe) => [pipe.id, nodeTotal(pipe.fromId)]));
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function pipeRow(
  doc: CadDocument,
  civil: CivilModel,
  pipe: PipeObject,
  designLps: number,
  criteria: DrainageCriteria,
): PipeRow {
  const from = civilObject(civil, pipe.fromId, 'manhole');
  const to = civilObject(civil, pipe.toId, 'manhole');
  const lengthM = toMetres(doc, pipePlanLength(civil, pipe) ?? 0);
  const diameterM = toMetres(doc, pipe.diameter);
  const slope = pipeSlope(civil, pipe);
  const fullLps = manningFullFlow(diameterM, slope, pipe.manningN) * 1000;
  const flow = solvePartialFlow(diameterM, slope, pipe.manningN, designLps / 1000);
  const coverFromM = toMetres(doc, (from?.rimElevation ?? 0) - (pipe.invertFrom + pipe.diameter));
  const coverToM = toMetres(doc, (to?.rimElevation ?? 0) - (pipe.invertTo + pipe.diameter));
  const reasons: string[] = [];
  if (!(slope > 0)) reasons.push('adverse or zero slope');
  else if (flow.surcharged) reasons.push('capacity exceeded (surcharged)');
  else if (flow.depthRatio > criteria.maxDepthRatio) {
    reasons.push(`depth ratio ${flow.depthRatio.toFixed(2)} > ${criteria.maxDepthRatio}`);
  }
  if (slope > 0 && designLps > 0) {
    if (flow.velocity < criteria.minVelocity) {
      reasons.push(`velocity ${flow.velocity.toFixed(2)} m/s < ${criteria.minVelocity}`);
    } else if (flow.velocity > criteria.maxVelocity) {
      reasons.push(`velocity ${flow.velocity.toFixed(2)} m/s > ${criteria.maxVelocity}`);
    }
  }
  for (const [end, cover] of [
    ['upstream', coverFromM],
    ['downstream', coverToM],
  ] as const) {
    if (cover < criteria.minCoverM) {
      reasons.push(`${end} cover ${cover.toFixed(2)} m < ${criteria.minCoverM} m`);
    }
  }
  return {
    id: pipe.id,
    name: pipe.name,
    fromId: pipe.fromId,
    toId: pipe.toId,
    lengthM: round(lengthM, 3),
    slopePct: round(slope * 100, 3),
    diameterMm: round(toMm(doc, pipe.diameter), 1),
    material: pipe.material,
    designLps: round(designLps, 2),
    fullLps: round(fullLps, 2),
    utilisation: fullLps > 0 ? round(designLps / fullLps, 3) : designLps > 0 ? 999 : 0,
    depthRatio: round(flow.depthRatio, 3),
    velocity: round(flow.velocity, 3),
    coverFromM: round(coverFromM, 3),
    coverToM: round(coverToM, 3),
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
  };
}

function manholeRow(
  doc: CadDocument,
  civil: CivilModel,
  manhole: ManholeObject,
  intensityMmH: number,
): ManholeRow {
  const pipes = civilObjectsOf(civil, 'pipe');
  const incoming = pipes.filter((pipe) => pipe.toId === manhole.id).map((pipe) => pipe.invertTo);
  const outgoing = pipes
    .filter((pipe) => pipe.fromId === manhole.id)
    .map((pipe) => pipe.invertFrom);
  const dropM =
    incoming.length > 0 && outgoing.length > 0
      ? round(toMetres(doc, Math.max(...incoming) - Math.min(...outgoing)), 3)
      : null;
  const reasons: string[] = [];
  if (dropM !== null && dropM < 0)
    reasons.push(`outgoing invert ${(-dropM).toFixed(3)} m above incoming`);
  if (!(manhole.rimElevation > manhole.invertElevation)) reasons.push('rim not above invert');
  return {
    id: manhole.id,
    name: manhole.name,
    depthM: round(toMetres(doc, manhole.rimElevation - manhole.invertElevation), 3),
    dropM,
    localLps: round(localFlowLps(manhole, intensityMmH), 2),
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
  };
}

export function analyseNetwork(
  doc: CadDocument,
  civil: CivilModel,
  criteria: DrainageCriteria,
): { pipes: PipeRow[]; manholes: ManholeRow[] } {
  const flows = pipeDesignFlows(civil, criteria.rainfallIntensityMmH);
  return {
    pipes: civilObjectsOf(civil, 'pipe').map((pipe) =>
      pipeRow(doc, civil, pipe, flows.get(pipe.id) ?? 0, criteria),
    ),
    manholes: civilObjectsOf(civil, 'manhole').map((manhole) =>
      manholeRow(doc, civil, manhole, criteria.rainfallIntensityMmH),
    ),
  };
}

export function toCsv(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  const cell = (value: unknown): string => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}
