/**
 * Modified rational method down the pipe DAG: time of concentration (entry time + travel times),
 * IDF intensity at that time, accumulated C*A and point inflow. A manhole with several outgoing
 * pipes splits its accumulated flow by full-bore capacity share.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel, PipeObject } from '@core/model/civil';
import { toMetres } from '../model';
import { civilObjectsOf } from './model';
import { fullArea, manningFullFlow, rationalFlowLps, solvePartialFlow } from './hydraulics';
import { DEFAULT_ENTRY_TIME_MIN, intensityAt, type DrainageCriteria } from './drainageCriteria';
import { manholesUpstreamFirst, pipePlanLength, pipeSlope } from './drainageTopology';

export interface PipeFlow {
  /** Time of concentration at the pipe's upstream end (minutes). */
  readonly tcMin: number;
  /** Intensity (mm/h) at `tcMin`. */
  readonly intensityMmH: number;
  /** Accumulated runoff coefficient x area carried by the pipe (ha). */
  readonly sumCAHa: number;
  /** Accumulated point inflow carried by the pipe (L/s). */
  readonly inflowLps: number;
  readonly designLps: number;
  /** Velocity used for travel time (m/s): part-full, or Q/A when surcharged; full-bore at no flow. */
  readonly velocity: number;
  readonly travelMin: number;
  /** Fraction of the upstream manhole's accumulated flow sent down this pipe (1 unless diverging). */
  readonly share: number;
}

export interface FlowResult {
  readonly pipes: ReadonlyMap<string, PipeFlow>;
  /** Manholes with more than one outgoing pipe. */
  readonly diverging: readonly string[];
}

function pipeVelocity(diameterM: number, slope: number, manningN: number, flowM3s: number): number {
  if (!(slope > 0)) return 0;
  if (!(flowM3s > 0)) return manningFullFlow(diameterM, slope, manningN) / fullArea(diameterM);
  return solvePartialFlow(diameterM, slope, manningN, flowM3s).velocity;
}

function capacityShares(
  doc: CadDocument,
  civil: CivilModel,
  outgoing: readonly PipeObject[],
): number[] {
  if (outgoing.length === 1) return [1];
  const capacities = outgoing.map((pipe) =>
    manningFullFlow(toMetres(doc, pipe.diameter), pipeSlope(civil, pipe), pipe.manningN),
  );
  const total = capacities.reduce((sum, value) => sum + value, 0);
  return capacities.map((value) => (total > 0 ? value / total : 1 / outgoing.length));
}

/** Flow, time of concentration and intensity per pipe for the current diameters. */
export function computeFlows(
  doc: CadDocument,
  civil: CivilModel,
  criteria: DrainageCriteria,
): FlowResult {
  const pipes = civilObjectsOf(civil, 'pipe').filter(
    (pipe) => pipePlanLength(civil, pipe) !== null,
  );
  const flows = new Map<string, PipeFlow>();
  const diverging: string[] = [];
  for (const manhole of manholesUpstreamFirst(civil)) {
    let sumCA = manhole.catchment
      ? manhole.catchment.runoffCoefficient * manhole.catchment.areaHa
      : 0;
    let inflow = manhole.inflow ?? 0;
    let tc =
      manhole.catchment || manhole.inflow ? (manhole.entryTimeMin ?? DEFAULT_ENTRY_TIME_MIN) : 0;
    for (const pipe of pipes.filter((p) => p.toId === manhole.id)) {
      const upstream = flows.get(pipe.id);
      if (!upstream) continue;
      sumCA += upstream.sumCAHa;
      inflow += upstream.inflowLps;
      if (upstream.sumCAHa > 0 || upstream.inflowLps > 0) {
        tc = Math.max(tc, upstream.tcMin + upstream.travelMin);
      }
    }
    const outgoing = pipes.filter((p) => p.fromId === manhole.id);
    if (outgoing.length > 1) diverging.push(manhole.id);
    const shares = capacityShares(doc, civil, outgoing);
    const tcMin = tc > 0 ? tc : DEFAULT_ENTRY_TIME_MIN;
    const intensityMmH = intensityAt(criteria, tcMin);
    outgoing.forEach((pipe, index) => {
      const share = shares[index] ?? 1;
      const diameterM = toMetres(doc, pipe.diameter);
      const designLps = rationalFlowLps(sumCA * share, intensityMmH, 1) + inflow * share;
      const velocity = pipeVelocity(
        diameterM,
        pipeSlope(civil, pipe),
        pipe.manningN,
        designLps / 1000,
      );
      const lengthM = toMetres(doc, pipePlanLength(civil, pipe) ?? 0);
      flows.set(pipe.id, {
        tcMin,
        intensityMmH,
        sumCAHa: sumCA * share,
        inflowLps: inflow * share,
        designLps,
        velocity,
        travelMin: velocity > 0 ? lengthM / velocity / 60 : 0,
        share,
      });
    });
  }
  return { pipes: flows, diverging };
}
