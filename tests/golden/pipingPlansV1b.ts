/**
 * Golden plans of 02 RTE V1 part 2: supports on a spec-driven run, heat tracing, and supports that follow a stretch (SC-RTE-16, 17, 18; V1c: SC-RTE-23). Replay re-mints
 * identical ids (L8); the run entities, the support entities and their attachment are re-derived on load. (The PCF goldens are the reference files
 * `__snapshots__/piping_pcf_*.pcf`, checked in tests/unit/plant/piping/pcf.test.ts.)
 */

import type { GoldenAction } from './plans';
import { plans } from './plans';
import { IMPORTS, tie } from './pipingPlans';

const beam = (x: number): GoldenAction => ({
  command: 'add_steel_member',
  params: { role: 'beam', start: [x, -1000, 2830], end: [x, 1000, 2830], profile: 'IPE200' },
});

export const pipingPlansV1b: Record<string, GoldenAction[]> = {
  // SC-RTE-16 / 18: the insulated DN80 hot line over three beams, a shoe on each, two electric tracers.
  piping_run_supports_tracing: [
    ...IMPORTS,
    tie('TP-H1', [0, 0, 3000], [1, 0, 0], 80, 'h1'),
    tie('TP-H2', [6000, 0, 3000], [-1, 0, 0], 80, 'h2'),
    {
      command: 'create_pipeline',
      params: {
        service: 'HO',
        sequence: '4001',
        spec: 'CS150',
        dn: 80,
        designTempC: 180,
        insulation: { code: 'H', thickness: 'fromSpec' },
      },
      as: 'line',
    },
    { command: 'route_pipe', params: { lineId: '$line', from: { portId: '$h1' }, to: { portId: '$h2' } }, as: 'run' },
    beam(500),
    beam(3000),
    beam(5500),
    { command: 'add_pipe_support', params: { runId: '$run', spacing: 3000 } },
    {
      command: 'set_heat_tracing',
      params: {
        lineId: '$line',
        type: 'electric',
        tracers: 2,
        maintainTempC: 150,
        allowances: { valveM: 1, flangeM: 0.5, supportM: 0.25 },
      },
    },
    { command: 'check_pipe_supports', params: {} },
    { command: 'piping_takeoff', params: { runId: '$run' } },
  ],
  // SC-RTE-17: SC-RTE-01 with a shoe under the +X leg; the vessel moves 500 in Y and the shoe follows the leg (re-snapped, kept on its beam).
  piping_run_supports_stretch: [
    ...(plans['piping_pump_to_vessel'] as GoldenAction[]).slice(0, -1),
    { command: 'add_steel_member', params: { role: 'beam', start: [1500, 2000, 2300], end: [1500, 4000, 2300], profile: 'IPE200' } },
    { command: 'add_pipe_support', params: { runId: '$run', at: [[1500, 3000, 2500]] } },
    { command: 'update_equipment_parameters', params: { equipment: 'V-101', set: { location: [7000, 3500] } } },
    { command: 'check_pipe_supports', params: {} },
  ],
  // SC-RTE-23: a kinked legacy pipe with three shoes is converted with replace; the shoes move 5 / 10 / 5 mm onto the straightened run.
  piping_convert_replace_supports: [
    ...IMPORTS,
    {
      command: 'add_pipe_run',
      params: {
        points: [
          [0, 0, 1500],
          [2000, 10, 1500],
          [4000, 0, 1500],
        ],
        dn: 100,
        line: 'L-1',
        service: 'cooling water',
      },
      as: 'legacy',
    },
    {
      command: 'add_pipe_support',
      params: {
        pipeId: '$legacy',
        at: [
          [1000, 5, 1500],
          [2000, 10, 1500],
          [3000, 5, 1500],
        ],
        type: 'shoe',
      },
    },
    { command: 'convert_pipe_run', params: { pipeId: '$legacy', spec: 'CS150', replace: true }, as: 'run' },
    { command: 'check_pipe_supports', params: {} },
  ],
};
