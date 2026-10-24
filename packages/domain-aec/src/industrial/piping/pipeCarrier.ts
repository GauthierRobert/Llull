/**
 * The ONE lookup of what a pipe support rests on (02 RTE V1 part 2): a support's `pipeId` names either a building pipe element (`add_pipe_run`) or a
 * spec-driven plant run (`route_pipe`, `plant.piping.runs`). Every reader of a support's carrier (geometry, IFC, plan symbols, clash boxes, the span /
 * weight / load checks, the schedule, the re-attachment) goes through `carrierPipe`, which returns the carrier as a `PipeElement`, so no consumer
 * can read one pipe kind only. A run is returned in the frame of the level asked for (a support: its own level; else the run's own level).
 */

import type { BuildingModel, PipeElement, PipeSupportElement } from '@aec/building/types';
import { elementsOf } from '../../building/model';
import { getPiping } from '../../plant/piping/model';
import { type CarrierDoc, runCarrierPipe } from '../../plant/piping/runCarrier';

/** The pipe `pipeId` as a pipe element in the frame of level `levelId`: a building pipe of `building`, else the plant run of that id; undefined when neither exists. */
function carrierPipe(doc: CarrierDoc, building: BuildingModel, pipeId: string, levelId: string): PipeElement | undefined {
  const element = building.elements[pipeId];
  if (element !== undefined) return element.category === 'pipe' ? element : undefined;
  return runCarrierPipe(doc, pipeId, levelId);
}

/** The carrier of `support` (in the support's own level frame). */
export const carrierOfSupport = (
  doc: CarrierDoc,
  building: BuildingModel,
  support: Pick<PipeSupportElement, 'pipeId' | 'levelId'>,
): PipeElement | undefined => carrierPipe(doc, building, support.pipeId, support.levelId);

/** The plant runs as pipes, in run order, each in the frame of its own level (`levelOfElevation`). */
export const runPipes = (doc: CarrierDoc): PipeElement[] => getPiping(doc).runOrder.flatMap((id) => runCarrierPipe(doc, id) ?? []);

/** Every pipe a support can rest on: the building pipes in model order, then the plant runs in run order (each run in the frame of its own level). */
export const carrierPipes = (doc: CarrierDoc, building: BuildingModel): PipeElement[] => [
  ...elementsOf(building, 'pipe'),
  ...runPipes(doc),
];

/** True when `pipeId` is a plant run (and not a building element). */
export const isRunCarrier = (doc: CarrierDoc, building: BuildingModel, pipeId: string): boolean =>
  building.elements[pipeId] === undefined && getPiping(doc).runs[pipeId] !== undefined;

/** The pipe supports whose `pipeId` names neither a building pipe nor a plant run (their pipe or run was deleted), in model order. */
export const orphanSupports = (doc: CarrierDoc, building: BuildingModel): PipeSupportElement[] =>
  elementsOf(building, 'pipeSupport').filter(
    (support) => building.elements[support.pipeId] === undefined && getPiping(doc).runs[support.pipeId] === undefined,
  );
