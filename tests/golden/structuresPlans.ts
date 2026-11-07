/**
 * Golden plan of 06 STA (VC-STA-14): a vessel with a half-round platform and a caged ladder, a deck with a steel stair and a short pipe rack, then the
 * access graph, the reachability of two operating points, the access check and the plan symbols. Replay re-mints identical ids (L8); parts of the
 * assemblies are re-derived by the commands.
 */

import type { GoldenAction } from './plans';

export const structuresPlans: Record<string, GoldenAction[]> = {
  plant_access_structures: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_level', params: { name: 'Grade', elevation: 0, height: 7000 }, as: 'grade' },
    {
      command: 'add_equipment',
      params: { name: 'Column', mark: 'C-101', location: [0, 0], size: [3000, 3000, 18000], shape: 'vertical_vessel' },
      as: 'vessel',
    },
    {
      command: 'add_circular_access_platform',
      params: {
        equipmentId: '$vessel',
        elevation: 6000,
        startAngleDeg: 0,
        sweepDeg: 180,
        gap: 150,
        width: 1000,
        railing: { edges: ['outer', 'ends'], height: 1100 },
      },
      as: 'ring',
    },
    {
      command: 'add_ladder',
      params: { base: [2150, -250, 0], facing: [0, 1], attachTo: '$ring', exit: 'through', fallProtection: 'cage', levelId: '$grade' },
      as: 'ladder',
    },
    {
      command: 'add_access_platform',
      params: {
        bounds: [
          [8000, 0],
          [11000, 2000],
        ],
        topOffset: 3000,
        gratingType: '19-W-4 1-1/4x3/16',
        bearingBarDirection: [1, 0],
        levelId: '$grade',
        railing: {},
      },
      as: 'deck',
    },
    {
      command: 'add_steel_stair',
      params: { start: [3520, 1000, 0], angle: 0, toSurfaceId: '$deck', riserMax: 180, going: 280, levelId: '$grade' },
      as: 'stair',
    },
    {
      command: 'add_pipe_rack',
      params: {
        origin: [0, -8000],
        direction: [1, 0],
        length: 12000,
        bentSpacing: 6000,
        width: 4000,
        tiers: [5000],
        columnProfile: 'HEB300',
        tierBeamProfile: 'IPE300',
        gridPrefix: 'PR',
        levelId: '$grade',
      },
      as: 'rack',
    },
    { command: 'access_graph', params: {} },
    {
      command: 'check_reachability',
      params: {
        targets: [
          { tag: 'HV-101', kind: 'valve_handwheel', point: [0, 2200, 6900] },
          { tag: 'HV-201', kind: 'valve_handwheel', point: [9500, 1000, 3900] },
        ],
        operatingHeightMm: { min: 0, max: 1800, source: 'project rule (owner supplied)' },
        maxHorizontalReachMm: 600,
      },
    },
    {
      command: 'check_access',
      params: { rulesets: ['iso_14122', 'osha_1910'], edgeDropThresholdMm: 500, edgeDropSource: 'project rule (owner supplied)' },
    },
    { command: 'export_access_plan', params: { formats: ['svg', 'dxf'] } },
    { command: 'building_schedule', params: { kind: 'access' } },
  ],
  /** STA-FU follow-ups: nozzle and manway targets, update_ladder / update_steel_stair, clashes of the access hardware, stair headroom, wedge-panel grating, a guard-rail between two touching decks. */
  plant_access_structures_followups: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_level', params: { name: 'Grade', elevation: 0, height: 7000 }, as: 'grade' },
    {
      command: 'add_equipment',
      params: { name: 'Column', mark: 'C-101', location: [0, 0], size: [3000, 3000, 18000], shape: 'vertical_vessel' },
      as: 'vessel',
    },
    {
      command: 'add_nozzle',
      params: {
        equipment: 'C-101',
        mark: 'N1',
        dn: 100,
        rating: 'CL150',
        facing: 'RF',
        projection: 200,
        location: { on: 'free', position: [1500, 0, 6900], direction: [1, 0, 0] },
      },
    },
    {
      command: 'add_nozzle',
      params: {
        equipment: 'C-101',
        mark: 'M1',
        service: 'manway',
        dn: 500,
        rating: 'CL150',
        facing: 'RF',
        projection: 200,
        location: { on: 'free', position: [1500, 500, 6900], direction: [1, 0, 0] },
      },
    },
    {
      command: 'add_circular_access_platform',
      params: { equipmentId: '$vessel', elevation: 6000, startAngleDeg: 0, sweepDeg: 180, gap: 150, width: 1000 },
      as: 'ring',
    },
    {
      command: 'add_ladder',
      params: { base: [2150, -250, 0], facing: [0, 1], attachTo: '$ring', exit: 'through', fallProtection: 'cage', levelId: '$grade' },
      as: 'ladder',
    },
    { command: 'update_ladder', params: { id: '$ladder', rungPitchMax: 300 } },
    {
      command: 'add_slab',
      params: {
        boundary: [
          [8000, 0],
          [11000, 0],
          [11000, 2000],
          [8000, 2000],
        ],
        thickness: 30,
        offset: 3000,
        levelId: '$grade',
      },
      as: 'deckA',
    },
    {
      command: 'add_slab',
      params: {
        boundary: [
          [11000, 0],
          [14000, 0],
          [14000, 2000],
          [11000, 2000],
        ],
        thickness: 30,
        offset: 3000,
        levelId: '$grade',
      },
      as: 'deckB',
    },
    {
      command: 'add_steel_stair',
      params: { start: [3520, 1000, 0], angle: 0, toSurfaceId: '$deckA', riserMax: 180, going: 280, levelId: '$grade' },
      as: 'stair',
    },
    { command: 'update_steel_stair', params: { id: '$stair', width: 900 } },
    {
      command: 'add_railing',
      params: {
        path: [
          [11000, 0, 3000],
          [11000, 2000, 3000],
        ],
        levelId: '$grade',
      },
    },
    { command: 'access_graph', params: {} },
    { command: 'check_clashes', params: {} },
    { command: 'check_grating', params: { uniformLoadKPa: 2, deflectionRatio: 100 } },
    { command: 'check_access', params: { rulesets: ['iso_14122'] } },
    {
      command: 'check_reachability',
      params: {
        targetsFrom: ['nozzles', 'manways'],
        operatingHeightMm: { min: 0, max: 1800, source: 'project rule (owner supplied)' },
        maxHorizontalReachMm: 600,
      },
    },
  ],
};
