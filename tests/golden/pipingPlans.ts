/**
 * Golden plans of 02 RTE M2 (SC-RTE-02, 03, 09 and a reducer run) on the pack's CS150 stub catalogue and spec: valves, branches, reducers and the
 * conversion of a legacy pipe. Replay re-mints identical ids (L8) and the derived entities are re-derived, so the snapshots stay small and exact.
 */

import { rteJson } from '../unit/plant/piping/rteFixtures';
import { plans, type GoldenAction } from './plans';

const IMPORTS: GoldenAction[] = [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'import_piping_catalog', params: { catalog: rteJson('catalog_stub_cs150.json') } },
  { command: 'import_pipe_spec', params: { spec: rteJson('spec_cs150.json') } },
];

const tie = (tag: string, position: number[], direction: number[], dn: number, as: string): GoldenAction => ({
  command: 'add_tie_in_point',
  params: { tag, position, direction, dn, endType: 'BW' },
  as,
});

export const pipingPlans: Record<string, GoldenAction[]> = {
  // SC-RTE-02: SC-RTE-01 plus the NPS 4 gate valve XV-1001 on the first leg, checked against a 1500 mm handwheel limit.
  piping_gate_valve: [
    ...(plans['piping_pump_to_vessel'] as GoldenAction[]).slice(0, -1),
    {
      command: 'insert_inline_component',
      params: { runId: '$run', type: 'valveGate', tag: 'XV-1001', at: { leg: 0, centreDistance: 800 }, stemDirection: [0, -1, 0] },
      as: 'valve',
    },
    { command: 'check_piping', params: { lineIds: ['$line'], maxHandwheelCentreHeight: 1500 } },
    { command: 'move_inline_component', params: { runId: '$run', componentId: '$valve', delta: 100 } },
    { command: 'piping_takeoff', params: { runId: '$run' } },
  ],
  // SC-RTE-03: DN150 header with a reducing tee 6x4 to a tie-in and a weldolet 6x2 left open.
  piping_header_branches: [
    ...IMPORTS,
    tie('TP-1', [0, 0, 3000], [1, 0, 0], 150, 'tp1'),
    tie('TP-2', [10000, 0, 3000], [-1, 0, 0], 150, 'tp2'),
    tie('TP-3', [4000, 2000, 3000], [0, -1, 0], 100, 'tp3'),
    { command: 'create_pipeline', params: { service: 'CW', sequence: '2001', spec: 'CS150', dn: 150 }, as: 'line' },
    { command: 'route_pipe', params: { lineId: '$line', from: { portId: '$tp1' }, to: { portId: '$tp2' } }, as: 'header' },
    { command: 'add_branch', params: { runId: '$header', at: { point: [4000, 0, 3000] }, dn: 100, to: { portId: '$tp3' } }, as: 'branch4' },
    {
      command: 'add_branch',
      params: { runId: '$header', at: { point: [7000, 0, 3000] }, dn: 50, legs: [{ direction: '+Z', length: 1000 }] },
      as: 'branch2',
    },
    { command: 'piping_connectivity', params: { lineIds: ['$line'] } },
    { command: 'check_piping', params: { lineIds: ['$line'] } },
    { command: 'piping_takeoff', params: { lineId: '$line' } },
  ],
  // A DN150 line meets a DN100 port through a 6x4 concentric reducer placed while routing.
  piping_reducer_run: [
    ...IMPORTS,
    tie('RA', [0, 0, 0], [1, 0, 0], 150, 'ra'),
    tie('RB', [6000, 0, 0], [-1, 0, 0], 100, 'rb'),
    { command: 'create_pipeline', params: { service: 'P', sequence: '3001', spec: 'CS150', dn: 150 }, as: 'line' },
    {
      command: 'route_pipe',
      params: {
        lineId: '$line',
        from: { portId: '$ra' },
        to: { portId: '$rb' },
        inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
      },
      as: 'run',
    },
    { command: 'piping_takeoff', params: { runId: '$run' } },
  ],
  // SC-RTE-09: a legacy add_pipe_run polyline becomes a spec-driven run (the legacy pipe is replaced).
  piping_legacy_conversion: [
    ...IMPORTS,
    {
      command: 'add_pipe_run',
      params: {
        points: [
          [1000, 3000, 1500],
          [5000, 3000, 1500],
          [5000, 6000, 1500],
          [5000, 6000, 4000],
        ],
        dn: 100,
        line: 'L-1',
        service: 'cooling water',
      },
      as: 'legacy',
    },
    { command: 'convert_pipe_run', params: { pipeId: '$legacy', spec: 'CS150', replace: true }, as: 'run' },
    { command: 'piping_takeoff', params: { runId: '$run' } },
    { command: 'check_piping', params: {} },
  ],
};
