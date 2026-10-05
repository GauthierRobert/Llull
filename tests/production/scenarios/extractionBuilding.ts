import type { Scenario } from '../contract';
import { coordinationCriteria } from '../criteria/plantCoordination';
import { deliverableCriteria } from '../criteria/deliverables';
import { equipmentCriteria } from '../criteria/plantEquipment';
import { integrityCriteria } from '../criteria/integrity';
import { pipingCriteria } from '../criteria/plantPiping';
import { structureCriteria } from '../criteria/plantStructure';
import { plantBrief } from '../plant/brief';
import { plantScript } from '../plant/script';
import { extractionIntent } from './extractionIntent';

/**
 * @layer tests/production/scenarios
 *
 * Desmet-type job 1: model the solvent extraction building (structure + equipment + main lines)
 * from the brief and issue the coordination package.
 */
export const extractionBuilding: Scenario = {
  id: 'desmet-extraction-building',
  title: 'Solvent extraction building — structure, equipment, lines, issue for coordination',
  client: 'Desmet',
  brief: plantBrief(extractionIntent),
  script: plantScript(extractionIntent),
  criteria: [
    ...structureCriteria(extractionIntent),
    ...equipmentCriteria(extractionIntent),
    ...pipingCriteria(extractionIntent),
    ...coordinationCriteria(extractionIntent),
    ...deliverableCriteria(extractionIntent),
    ...integrityCriteria(),
  ],
  knownIssues: {
    scripted: [],
    ui: [],
  },
  agentBaseline: 0.6,
};
