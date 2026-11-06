/**
 * Golden plan of 02 RTE CAT-FU: a socket-weld run closed by a spec cap (`set_run_end_cap`). The cap catalogue is a declared test input (capFixtures).
 * Replay re-mints identical ids (L8); the run entities, cap part included, are re-derived on load.
 */

import { rteJson } from '../unit/plant/piping/rteFixtures';
import { capCatalog, capSpecOps } from '../unit/plant/piping/capFixtures';
import type { GoldenAction } from './plans';
import { tie } from './pipingPlans';

export const cappedRunSteps: GoldenAction[] = [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'import_piping_catalog', params: { catalog: rteJson('catalog_stub_small_bore.json') } },
  { command: 'import_piping_catalog', params: { catalog: capCatalog } },
  { command: 'import_pipe_spec', params: { spec: rteJson('spec_sw800.json') } },
  {
    command: 'edit_pipe_spec',
    params: { specId: 'SW800', ops: capSpecOps('cap-sw', ['rte-validation-stub-small-bore', 'llull-open-piping']) },
  },
  tie('CAP-A', [0, 0, 0], [0, 0, 1], 25, 'capTie', 'SW'),
  { command: 'create_pipeline', params: { service: 'P', sequence: '5002', spec: 'SW800', dn: 25 }, as: 'capLine' },
  {
    command: 'route_pipe',
    params: {
      lineId: '$capLine',
      from: { portId: '$capTie' },
      legs: [
        { direction: '+Z', length: 1000 },
        { direction: '+X', length: 1500 },
      ],
    },
    as: 'capRun',
  },
  { command: 'set_run_end_cap', params: { runId: '$capRun', end: 'end' } },
  { command: 'check_piping', params: { lineIds: ['$capLine'] } },
  { command: 'piping_takeoff', params: { runId: '$capRun' } },
];

export const pipingPlansCap: Record<string, GoldenAction[]> = {
  // Cap run end (CAT-FU 2): socket-weld DN25 line from a SW tie-in, open end closed by the spec cap; takeoff counts it, check_piping has no open end there.
  piping_capped_run_end: cappedRunSteps,
};
