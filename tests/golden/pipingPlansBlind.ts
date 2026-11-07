/**
 * Golden plans of 05 ISO M6c on the CS150 stub: a blind flange as a run end (`set_run_end_cap closure blindFlange`), and a mid-line flanged joint with a flanged instrument,
 * each exported as PCF. The cap / blind rows are declared test inputs (routeExtraFixtures). Replay re-mints identical ids (L8); the parts are re-derived on load.
 */

import { extraCatalog, extrasSpecOps } from '../unit/plant/fabrication/routeExtraFixtures';
import type { GoldenAction } from './plans';
import { IMPORTS, tie } from './pipingPlans';

/** Steps that add the test rows to CS150 and route a DN100 line with a joint, an instrument and a blind-flanged end (needs CS150 in the document). */
export const blindRunSteps: GoldenAction[] = [
  { command: 'import_piping_catalog', params: { catalog: extraCatalog } },
  { command: 'edit_pipe_spec', params: { specId: 'CS150', ops: extrasSpecOps(['rte-validation-stub', 'llull-open-piping']) } },
  tie('BL-A', [0, 20000, 0], [1, 0, 0], 100, 'blindTie'),
  { command: 'create_pipeline', params: { service: 'P', sequence: '5003', spec: 'CS150', dn: 100 }, as: 'blindLine' },
  {
    command: 'route_pipe',
    params: {
      lineId: '$blindLine',
      from: { portId: '$blindTie' },
      legs: [{ direction: '+X', length: 4000 }],
      inline: [
        { type: 'flangedJoint', tag: 'FJ-1', at: { leg: 0, centreDistance: 1500 } },
        { type: 'instrument', tag: 'FT-1', lengthMm: 300, at: { leg: 0, centreDistance: 3000 } },
      ],
    },
    as: 'blindRun',
  },
  { command: 'set_run_end_cap', params: { runId: '$blindRun', end: 'end', closure: 'blindFlange' } },
  { command: 'check_piping', params: { lineIds: ['$blindLine'] } },
  { command: 'piping_takeoff', params: { runId: '$blindRun' } },
  { command: 'export_pcf', params: { lineIds: ['$blindLine'] } },
];

export const pipingPlansBlind: Record<string, GoldenAction[]> = {
  // 05 ISO M6c: DN100 line from a BW tie-in with a flanged joint at 1500, a flanged instrument at 3000 and its end closed by a blind flange; exported as PCF.
  piping_blind_joint_instrument: [...IMPORTS, ...blindRunSteps],
};
