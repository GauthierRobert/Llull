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
import { DEFAULT_ENTRY_TIME_MIN, intensityAt, type DrainageCriteria } from './drainageCriteria';
import { computeFlows, type PipeFlow } from './drainageFlow';
import { computeHgl, type ManholeHgl, type PipeHgl } from './drainageHgl';
import { pipePlanLength, pipeSlope } from './drainageTopology';

export interface PipeRow {
  readonly id: string;
  readonly name: string;
  readonly fromId: string;
  readonly toId: string;
  readonly lengthM: number;
  readonly slopePct: number;
  readonly diameterMm: number;
  readonly material: string;
  /** Time of concentration at the upstream end (min). */
  readonly tcMin: number;
  readonly intensityMmH: number;
  /** Accumulated runoff coefficient x area (ha). */
  readonly sumCAHa: number;
  readonly designLps: number;
  readonly fullLps: number;
  readonly utilisation: number;
  readonly depthRatio: number;
  readonly velocity: number;
  readonly coverFromM: number;
  readonly coverToM: number;
  readonly hglUpM: number;
  readonly hglDownM: number;
  readonly surcharged: boolean;
  readonly flooding: boolean;
  readonly status: 'pass' | 'fail';
  readonly reasons: string[];
}

export interface ManholeRow {
  readonly id: string;
  readonly name: string;
  readonly depthM: number;
  readonly dropM: number | null;
  readonly localLps: number;
  readonly entryTimeMin: number;
  readonly hglM: number;
  readonly flooding: boolean;
  readonly status: 'pass' | 'fail';
  readonly reasons: string[];
}

/** Runoff plus point inflow generated at a manhole itself (L/s). */
export function localFlowLps(manhole: ManholeObject, intensityMmH: number): number {
  const runoff = manhole.catchment
    ? rationalFlowLps(manhole.catchment.runoffCoefficient, intensityMmH, manhole.catchment.areaHa)
    : 0;
  return runoff + (manhole.inflow ?? 0);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function pipeRow(
  doc: CadDocument,
  civil: CivilModel,
  pipe: PipeObject,
  flowInfo: PipeFlow | undefined,
  hgl: PipeHgl | undefined,
  criteria: DrainageCriteria,
): PipeRow {
  const designLps = flowInfo?.designLps ?? 0;
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
  if (hgl?.surcharged && !flow.surcharged) reasons.push('HGL above obvert (surcharged)');
  return {
    id: pipe.id,
    name: pipe.name,
    fromId: pipe.fromId,
    toId: pipe.toId,
    lengthM: round(lengthM, 3),
    slopePct: round(slope * 100, 3),
    diameterMm: round(toMm(doc, pipe.diameter), 1),
    material: pipe.material,
    tcMin: round(flowInfo?.tcMin ?? DEFAULT_ENTRY_TIME_MIN, 2),
    intensityMmH: round(flowInfo?.intensityMmH ?? intensityAt(criteria, DEFAULT_ENTRY_TIME_MIN), 2),
    sumCAHa: round(flowInfo?.sumCAHa ?? 0, 4),
    designLps: round(designLps, 2),
    fullLps: round(fullLps, 2),
    utilisation: fullLps > 0 ? round(designLps / fullLps, 3) : designLps > 0 ? 999 : 0,
    depthRatio: round(flow.depthRatio, 3),
    velocity: round(flow.velocity, 3),
    coverFromM: round(coverFromM, 3),
    coverToM: round(coverToM, 3),
    hglUpM: round(hgl?.hglUpM ?? 0, 3),
    hglDownM: round(hgl?.hglDownM ?? 0, 3),
    surcharged: hgl?.surcharged ?? false,
    flooding: hgl?.flooding ?? false,
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
  };
}

function manholeRow(
  doc: CadDocument,
  civil: CivilModel,
  manhole: ManholeObject,
  hgl: ManholeHgl | undefined,
  criteria: DrainageCriteria,
): ManholeRow {
  const entryTimeMin = manhole.entryTimeMin ?? DEFAULT_ENTRY_TIME_MIN;
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
  if (hgl?.flooding) {
    reasons.push(
      `HGL ${hgl.hglM.toFixed(3)} m above rim - freeboard ${criteria.freeboardM} m: flooding risk`,
    );
  }
  return {
    id: manhole.id,
    name: manhole.name,
    depthM: round(toMetres(doc, manhole.rimElevation - manhole.invertElevation), 3),
    dropM,
    localLps: round(localFlowLps(manhole, intensityAt(criteria, entryTimeMin)), 2),
    entryTimeMin,
    hglM: round(hgl?.hglM ?? 0, 3),
    flooding: hgl?.flooding ?? false,
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
  };
}

export interface NetworkAnalysis {
  readonly pipes: PipeRow[];
  readonly manholes: ManholeRow[];
  /** Manholes with several outgoing pipes (flow split by full-bore capacity share). */
  readonly diverging: readonly string[];
}

export function analyseNetwork(
  doc: CadDocument,
  civil: CivilModel,
  criteria: DrainageCriteria,
): NetworkAnalysis {
  const flows = computeFlows(doc, civil, criteria);
  const hgl = computeHgl(doc, civil, criteria, flows);
  return {
    pipes: civilObjectsOf(civil, 'pipe').map((pipe) =>
      pipeRow(doc, civil, pipe, flows.pipes.get(pipe.id), hgl.pipes.get(pipe.id), criteria),
    ),
    manholes: civilObjectsOf(civil, 'manhole').map((manhole) =>
      manholeRow(doc, civil, manhole, hgl.manholes.get(manhole.id), criteria),
    ),
    diverging: flows.diverging,
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
