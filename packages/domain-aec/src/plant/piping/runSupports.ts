/**
 * Pipe supports carried by plant runs (02 RTE V1 part 2): a support is a building element (`pipeSupport`) whose `pipeId` names the run. These
 * readers give the supports of each run for the takeoff (tracing allowances), the clash bodies (a run never clashes with its own supports) and the
 * delete / convert guards.
 */

import type { CadDocument } from '@core/model/types';
import type { PipeSupportElement } from '@aec/building/types';
import { getPiping } from './model';

/** Supports whose `pipeId` is a run of the document, by run id, in model order. */
export function supportsByRun(doc: Pick<CadDocument, 'building' | 'plant'>): Readonly<Record<string, PipeSupportElement[]>> {
  const result: Record<string, PipeSupportElement[]> = {};
  const runs = getPiping(doc).runs;
  const building = doc.building;
  if (building === undefined) return result;
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (element?.category !== 'pipeSupport' || runs[element.pipeId] === undefined || building.elements[element.pipeId] !== undefined)
      continue;
    (result[element.pipeId] ??= []).push(element);
  }
  return result;
}

/** Number of supports on each run (runs without one are absent). */
export function supportCountsByRun(doc: Pick<CadDocument, 'building' | 'plant'>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(supportsByRun(doc)).map(([runId, supports]) => [runId, supports.length]));
}
