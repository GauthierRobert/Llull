import type { Scenario, ToolCall } from '../contract';
import { coordinationCriteria } from '../criteria/plantCoordination';
import { deliverableCriteria } from '../criteria/deliverables';
import { equipmentCriteria } from '../criteria/plantEquipment';
import { integrityCriteria } from '../criteria/integrity';
import { pipingCriteria } from '../criteria/plantPiping';
import { revisionCriteria } from '../criteria/revision';
import { structureCriteria } from '../criteria/plantStructure';
import { PIPE_OD } from '../oracle/steel';
import { plantBrief } from '../plant/brief';
import { levelId, type IntentEquipment, type IntentPipe, type PlantIntent } from '../plant/intent';
import { stepIdOf } from '../plant/script';
import { extractionBuilding } from './extractionBuilding';
import { extractionIntent } from './extractionIntent';

/**
 * @layer tests/production/scenarios
 *
 * Desmet-type job 2: change order on the issued extraction building (revision B). The office edits
 * the existing model — it does not redraw it — and reissues: identities (marks, ids, IFC GlobalIds)
 * of untouched elements must survive so drawings, schedules and the BIM coordination stay valid.
 */

const EXTRACTOR = 'E-301';
const UPRATED = { length: 18000, weight: 72000 };
const PUMP: IntentEquipment = {
  tag: 'E-502',
  name: 'Miscella pump',
  level: 0,
  location: [19500, 11250],
  size: [1200, 600, 800],
  weight: 900,
  clearance: 600,
};
const PUMP_LINE: IntentPipe = {
  line: 'L-105',
  service: 'miscella',
  dn: 80,
  from: 'E-501',
  to: 'E-502',
  route: [
    [16000, 11250, 500],
    [19500, 11250, 500],
  ],
};
const PROJECT = { revision: 'B', date: '2026-10-19' };

export const revisedIntent: PlantIntent = {
  ...extractionIntent,
  project: { ...extractionIntent.project, ...PROJECT },
  equipment: [
    ...extractionIntent.equipment.map((e) =>
      e.tag === EXTRACTOR
        ? {
            ...e,
            size: [UPRATED.length, e.size[1], e.size[2]] as IntentEquipment['size'],
            weight: UPRATED.weight,
          }
        : e,
    ),
    PUMP,
  ],
  pipes: [...extractionIntent.pipes, PUMP_LINE],
};

function revisionScript(): ToolCall[] {
  const base = extractionBuilding.script;
  const index = base.findIndex(
    (call) => call.tool === 'add_equipment' && call.args['mark'] === EXTRACTOR,
  );
  const original = base[index]?.args ?? {};
  const size = original['size'] as number[];
  return [
    {
      tool: 'edit_step_params',
      args: {
        stepId: stepIdOf(base, index),
        params: { ...original, size: [UPRATED.length, size[1], size[2]], weight: UPRATED.weight },
      },
    },
    {
      tool: 'add_equipment',
      args: {
        mark: PUMP.tag,
        name: PUMP.name,
        levelId: levelId(PUMP.level),
        location: PUMP.location,
        size: PUMP.size,
        weight: PUMP.weight,
        clearance: PUMP.clearance,
      },
    },
    {
      tool: 'add_pipe_run',
      args: {
        levelId: levelId(0),
        points: PUMP_LINE.route,
        line: PUMP_LINE.line,
        dn: PUMP_LINE.dn,
        from: PUMP_LINE.from,
        to: PUMP_LINE.to,
        service: PUMP_LINE.service,
      },
    },
    { tool: 'set_project_info', args: PROJECT },
    { tool: 'check_clashes', args: {} },
  ];
}

const CHANGE_ORDER = [
  '',
  '## Change order CO-01 — issue revision B',
  'The model of revision A (above) is already open. Edit it; do not rebuild it: untouched elements must keep their ids, marks and IFC GlobalIds.',
  `1. Extractor ${EXTRACTOR} is uprated: length ${UPRATED.length} mm (same centre, width and height), operating weight ${UPRATED.weight} kg.`,
  `2. Add ${PUMP.tag} ${PUMP.name} on "${extractionIntent.levels[0]?.name ?? ''}": centre (${PUMP.location.join(', ')}), ${PUMP.size.join(' × ')}, ${PUMP.weight} kg, clearance ${PUMP.clearance}.`,
  `3. Add line ${PUMP_LINE.line} ${PUMP_LINE.service} DN${PUMP_LINE.dn} (OD ${PIPE_OD[PUMP_LINE.dn]}) from ${PUMP_LINE.from} to ${PUMP_LINE.to}: (${PUMP_LINE.route.map((p) => p.join(', ')).join(') → (')}).`,
  `4. Revision ${PROJECT.revision}, dated ${PROJECT.date}. The model must stay clash-free.`,
];

export const extractionRevision: Scenario = {
  id: 'desmet-extraction-revision-b',
  title: 'Change order on the issued extraction building — revision B',
  client: 'Desmet',
  startsFrom: extractionBuilding.id,
  brief: plantBrief(extractionIntent, CHANGE_ORDER),
  get script(): ToolCall[] {
    return revisionScript();
  },
  criteria: [
    ...revisionCriteria(revisedIntent, [EXTRACTOR]),
    ...structureCriteria(revisedIntent),
    ...equipmentCriteria(revisedIntent),
    ...pipingCriteria(revisedIntent),
    ...coordinationCriteria(revisedIntent),
    ...deliverableCriteria(revisedIntent),
    ...integrityCriteria(),
  ],
  knownIssues: {
    scripted: [],
    ui: [],
  },
  agentBaseline: 0.6,
};
