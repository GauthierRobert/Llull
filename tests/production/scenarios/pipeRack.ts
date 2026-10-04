import type { Scenario } from '../contract';
import { deliverableCriteria } from '../criteria/deliverables';
import { integrityCriteria } from '../criteria/integrity';
import { pipeRackCriteria } from '../criteria/pipeRack';
import { coordinationCriteria } from '../criteria/plantCoordination';
import { pipingCriteria } from '../criteria/plantPiping';
import { structureCriteria } from '../criteria/plantStructure';
import { plantBrief } from '../plant/brief';
import { plantScript } from '../plant/script';
import { RACK_RULES, pipeRackIntent } from './pipeRackIntent';

/** Criteria of the shared factories that do not apply to a rack (no floors, stairs, equipment). */
const NOT_ON_A_RACK = new Set(['floors', 'access', 'ifc-equipment-data']);
const applicable = (ids: { id: string }[]): boolean =>
  ids.every(({ id }) => !NOT_ON_A_RACK.has(id));

/**
 * @layer tests/production/scenarios
 *
 * Desmet-type job 3: model the inter-unit pipe rack (portal bents, two tiers, nine lines, cable
 * tray, road crossing) and issue it for the piping / civil coordination.
 */
export const pipeRack: Scenario = {
  id: 'desmet-pipe-rack',
  title: 'Inter-unit pipe rack — two tiers, nine lines, cable tray, road crossing',
  client: 'Desmet',
  brief: plantBrief(pipeRackIntent, [
    '- Rack checks the office runs before issue: every line and the tray supported on every bent, clear height over the road, clear gaps between lines, battery limit to battery limit continuity, line metres per DN in the takeoff and pipe schedule.',
  ]),
  script: plantScript(pipeRackIntent),
  criteria: [
    ...structureCriteria(pipeRackIntent),
    ...pipingCriteria(pipeRackIntent),
    ...coordinationCriteria(pipeRackIntent),
    ...pipeRackCriteria(pipeRackIntent, RACK_RULES),
    ...deliverableCriteria(pipeRackIntent),
    ...integrityCriteria(),
  ].filter((criterion) => applicable([criterion])),
  knownIssues: { scripted: ['structural-coverage'] },
  agentBaseline: 0.6,
};
