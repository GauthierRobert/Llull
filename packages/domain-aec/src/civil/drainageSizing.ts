/**
 * Iterative pipe sizing: diameters set the velocities (travel times, Tc, intensity, split shares)
 * and those set the flows that size the diameters; repeated until no diameter changes.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel } from '@core/model/civil';
import { fromMm } from '../model';
import { civilObjectsOf, withObject } from './model';
import { solvePartialFlow } from './hydraulics';
import type { DrainageCriteria } from './drainageCriteria';
import { computeFlows } from './drainageFlow';
import { pipeSlope } from './drainageTopology';

export const MAX_SIZING_ITERATIONS = 10;

export interface SizingResult {
  readonly civil: CivilModel;
  /** "<pipeId> -> Ø<mm>" for each pipe whose diameter differs from the input. */
  readonly changed: string[];
  readonly unsized: string[];
  readonly iterations: number;
  readonly converged: boolean;
}

export function sizeNetwork(
  doc: CadDocument,
  initial: CivilModel,
  criteria: DrainageCriteria,
  candidatesMm: readonly number[],
): SizingResult {
  let civil = initial;
  let unsized: string[] = [];
  let iterations = 0;
  let converged = false;
  while (iterations < MAX_SIZING_ITERATIONS && !converged) {
    iterations += 1;
    const flows = computeFlows(doc, civil, criteria).pipes;
    unsized = [];
    converged = true;
    for (const pipe of civilObjectsOf(civil, 'pipe')) {
      const slope = pipeSlope(civil, pipe);
      const flow = (flows.get(pipe.id)?.designLps ?? 0) / 1000;
      const pick = candidatesMm.find((mm) => {
        const result = solvePartialFlow(mm / 1000, slope, pipe.manningN, flow);
        return (
          slope > 0 &&
          !result.surcharged &&
          result.depthRatio <= criteria.maxDepthRatio &&
          (flow === 0 || result.velocity >= criteria.minVelocity)
        );
      });
      if (pick === undefined) {
        unsized.push(pipe.id);
        continue;
      }
      const diameter = fromMm(doc, pick);
      if (Math.abs(diameter - pipe.diameter) < 1e-9) continue;
      civil = withObject(civil, { ...pipe, diameter });
      converged = false;
    }
  }
  const changed = civilObjectsOf(civil, 'pipe').flatMap((pipe) => {
    const before = initial.objects[pipe.id];
    return before?.category === 'pipe' && Math.abs(before.diameter - pipe.diameter) >= 1e-9
      ? [`${pipe.id} -> Ø${Math.round((pipe.diameter / fromMm(doc, 1)) * 10) / 10}`]
      : [];
  });
  return { civil, changed, unsized, iterations, converged };
}
