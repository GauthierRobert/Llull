/**
 * Golden plans of 02 RTE V1 part 1 (SC-RTE-10 .. 15): socket-weld and threaded engagement, eccentric reducers, trimmed elbows and pipe bends, valve operators
 * with their clash, and the slope-preserving stretch. Replay re-mints identical ids (L8) and the derived entities are re-derived on load.
 */

import { rteJson } from '../unit/plant/piping/rteFixtures';
import type { GoldenAction } from './plans';
import { IMPORTS, tie } from './pipingPlans';

const smallBore = (specFile: string): GoldenAction[] => [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'import_piping_catalog', params: { catalog: rteJson('catalog_stub_small_bore.json') } },
  { command: 'import_pipe_spec', params: { spec: rteJson(specFile) } },
];

const SIXTY_DEGREES = [0.5, 0.8660254037844386, 0];

export const pipingPlansV1: Record<string, GoldenAction[]> = {
  // SC-RTE-10: socket-weld DN25 line from a SW tie-in: a SW gate valve at 500, one SW elbow, open end; checks and takeoff.
  piping_socket_weld_line: [
    ...smallBore('spec_sw800.json'),
    tie('SW-A', [0, 0, 0], [0, 0, 1], 25, 'a', 'SW'),
    { command: 'create_pipeline', params: { service: 'P', sequence: '5001', spec: 'SW800', dn: 25 }, as: 'line' },
    {
      command: 'route_pipe',
      params: {
        lineId: '$line',
        from: { portId: '$a' },
        legs: [
          { direction: '+Z', length: 1000 },
          { direction: '+X', length: 1500 },
        ],
        inline: [{ type: 'valveGate', tag: 'XV-5', at: { leg: 0, centreDistance: 500 }, stemDirection: [0, -1, 0] }],
      },
      as: 'run',
    },
    { command: 'check_piping', params: { lineIds: ['$line'] } },
    { command: 'piping_takeoff', params: { runId: '$run' } },
  ],
  // SC-RTE-11: threaded DN50 header with a threadolet 2x1 and a DN25 threaded branch.
  piping_threaded_branch: [
    ...smallBore('spec_thd800.json'),
    { command: 'create_pipeline', params: { service: 'A', sequence: '5002', spec: 'THD800', dn: 50 }, as: 'line' },
    {
      command: 'route_pipe',
      params: { lineId: '$line', from: { point: [0, 0, 0], direction: [1, 0, 0] }, legs: [{ direction: '+X', length: 2000 }] },
      as: 'header',
    },
    {
      command: 'add_branch',
      params: { runId: '$header', at: { leg: 0, distance: 1000 }, dn: 25, legs: [{ direction: '+Y', length: 1000 }] },
    },
    { command: 'piping_takeoff', params: { lineId: '$line' } },
  ],
  // SC-RTE-12: DN150 line with a flat-on-top eccentric reducer 6x4 before a riser; the offset moves the corner and the riser start.
  piping_eccentric_riser: [
    ...IMPORTS,
    tie('EA', [0, 0, 0], [1, 0, 0], 150, 'ea'),
    { command: 'create_pipeline', params: { service: 'P', sequence: '5003', spec: 'CS150', dn: 150 }, as: 'line' },
    {
      command: 'route_pipe',
      params: {
        lineId: '$line',
        from: { portId: '$ea' },
        legs: [
          { direction: '+X', length: 4000 },
          { direction: '+Z', length: 1000 },
        ],
        inline: [{ type: 'reducerEccentric', tag: 'RE-1', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 2000 } }],
      },
      as: 'run',
    },
    { command: 'check_piping', params: { lineIds: ['$line'] } },
    { command: 'piping_takeoff', params: { runId: '$run' } },
  ],
  // SC-RTE-13: a 60 degree turn as a trimmed 90 elbow (the spec allows it), then the same turn as a 500 mm pipe bend on a second line.
  piping_trimmed_and_bend: [
    ...IMPORTS,
    {
      command: 'edit_pipe_spec',
      params: {
        specId: 'CS150',
        ops: [{ op: 'setHeader', fields: { elbowAngles: { anglesDeg: [90, 45], toleranceDeg: 1, trimmedAllowed: true } } }],
      },
    },
    { command: 'create_pipeline', params: { service: 'P', sequence: '5004', spec: 'CS150', dn: 100 }, as: 'line' },
    {
      command: 'route_pipe',
      params: {
        lineId: '$line',
        from: { point: [0, 0, 0], direction: [1, 0, 0] },
        legs: [
          { direction: '+X', length: 3000 },
          { direction: SIXTY_DEGREES, length: 2000 },
        ],
      },
      as: 'trimmed',
    },
    { command: 'create_pipeline', params: { service: 'P', sequence: '5005', spec: 'CS150', dn: 100 }, as: 'line2' },
    {
      command: 'route_pipe',
      params: {
        lineId: '$line2',
        from: { point: [0, 5000, 0], direction: [1, 0, 0] },
        bendRadius: 500,
        legs: [
          { direction: '+X', length: 3000 },
          { direction: SIXTY_DEGREES, length: 2000 },
        ],
      },
      as: 'bent',
    },
    { command: 'check_piping', params: {} },
    { command: 'piping_takeoff', params: {} },
  ],
  // SC-RTE-14: a globe valve with an actuator under a beam (RTE_VALVE_OPERATOR_CLASH), then the same valve turned sideways.
  piping_valve_operator: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'import_piping_catalog', params: { catalog: rteJson('catalog_stub_cs150.json') } },
    { command: 'import_piping_catalog', params: { catalog: rteJson('catalog_stub_operators.json') } },
    { command: 'import_pipe_spec', params: { spec: rteJson('spec_cs150_operators.json') } },
    tie('OA', [0, 0, 0], [1, 0, 0], 100, 'oa'),
    tie('OB', [6000, 0, 0], [-1, 0, 0], 100, 'ob'),
    { command: 'create_pipeline', params: { service: 'P', sequence: '5006', spec: 'CS150OP', dn: 100 }, as: 'line' },
    { command: 'route_pipe', params: { lineId: '$line', from: { portId: '$oa' }, to: { portId: '$ob' } }, as: 'run' },
    {
      command: 'insert_inline_component',
      params: { runId: '$run', type: 'valveGlobe', tag: 'XV-6', at: { leg: 0, centreDistance: 3000 } },
      as: 'valve',
    },
    { command: 'add_steel_member', params: { role: 'beam', start: [3000, -1000, 700], end: [3000, 1000, 700], profile: 'IPE200' } },
    { command: 'check_piping', params: { lineIds: ['$line'] } },
    { command: 'check_clashes', params: {} },
    { command: 'remove_inline_component', params: { runId: '$run', componentId: '$valve' } },
    {
      command: 'insert_inline_component',
      params: { runId: '$run', type: 'valveGlobe', tag: 'XV-6', at: { leg: 0, centreDistance: 3000 }, stemDirection: [1, 0, 0] },
    },
    { command: 'check_piping', params: { lineIds: ['$line'] } },
  ],
  // SC-RTE-15: a sloped drain from a pump nozzle to a hub; the pump moves 500 along the plan direction and the sloped leg keeps its 1 %.
  piping_slope_stretch: [
    ...IMPORTS,
    {
      command: 'add_equipment',
      params: { name: 'Drain pump', mark: 'P-301', location: [0, -300], size: [1200, 600, 800], weight: 650 },
      as: 'pump',
    },
    {
      command: 'add_nozzle',
      params: {
        equipment: 'P-301',
        mark: 'N1',
        dn: 100,
        rating: 'CL150',
        facing: 'RF',
        location: { on: 'free', position: [0, 300, 1000], direction: [1, 0, 0] },
        projection: 300,
      },
    },
    tie('TP-D2', [8000, 0, 0], [0, 0, 1], 100, 'hub'),
    { command: 'create_pipeline', params: { service: 'D', sequence: '5007', spec: 'CS150', dn: 100 }, as: 'line' },
    {
      command: 'route_pipe',
      params: {
        lineId: '$line',
        from: { portId: 'P-301:N1' },
        to: { portId: '$hub' },
        legs: [{ direction: '+X', planLength: 8000, slope: { value: 1, unit: 'percent', fall: true } }],
      },
      as: 'run',
    },
    { command: 'update_equipment', params: { elementId: '$pump', location: [500, -300] } },
    { command: 'piping_takeoff', params: { runId: '$run' } },
  ],
};
