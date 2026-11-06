/**
 * One valid seed document per plugin that owns a document slice (tests/unit/contract/pluginSliceFuzz.test.ts). A new plugin with a
 * `document` extension MUST add its row here: the fuzz test fails naming a plugin without one. Seeds are built through real commands (golden /
 * oracle plans and unit fixtures).
 */

import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setSignaturePort } from '@core/commands/signaturePort';
import type { ExecutionContext } from '@core/commands/types';
import { FEED_PUMP, runSteps } from '../unit/plant/pid/authoringFixtures';
import { runPlan } from '../golden/runPlan';
import { plans, type GoldenAction } from '../golden/plans';
import { plmPlans } from '../golden/plmPlans';
import { implicitPlans } from '../golden/implicitPlans';
import { cappedRunSteps } from '../golden/pipingPlansCap';
import { rteJson } from '../unit/plant/piping/rteFixtures';
import { recordedModel } from '../unit/plant/stress/m3Fixtures';
import { libraryDocument } from '../unit/plant/data/dataFixtures';
import { fixturePcf } from '../unit/plant/fabrication/fabricationFixtures';
import { addBody, caseParams, metreDocument, ok } from '../unit/aero/cfd/fixtures';
import { docWith, sampleCatalogFile } from '../unit/aero/fasteners/fixtures';
import { bracket, RULE } from '../unit/aero/sheetmetal/helpers';
import { mbbModel } from '../unit/cae/topology/support';
import { barModel } from '../unit/cae/explicit/support';
import { fixturePort, KEY_A } from '../unit/scan/fixturePort';
import {
  bemNozzles,
  bemParams,
  pumpParams,
  separatorNozzles,
  separatorParams,
  tankParams,
} from '../unit/plant/equipment/equipmentFixtures';

/** A command run on the loaded document: `params` may depend on the document (a missing id is a refusal, never a finding). */
interface SeedCommand {
  readonly name: string;
  readonly params: (doc: CadDocument) => Record<string, unknown>;
}

export interface PluginSliceSeed {
  /** Dotted top-level paths of the slice the plugin owns (mutations are drawn inside them). */
  readonly roots: readonly string[];
  /** A document holding a populated, valid slice. */
  readonly build: () => CadDocument;
  /** Context for the post-load commands (kernel-free: a command that needs one is refused, which is fine). */
  readonly ctx?: () => ExecutionContext | undefined;
  /** A cheap read-only command of the plugin (absent when the plugin has none). */
  readonly query?: SeedCommand;
  /** A command of the plugin that changes the document (absent when the plugin has none). */
  readonly mutate?: SeedCommand;
}

const constant = (params: Record<string, unknown>) => (): Record<string, unknown> => params;
const first = (record: object | undefined): string => Object.keys(record ?? {})[0] ?? 'missing';

function planDocument(actions: readonly GoldenAction[] | undefined, name: string): CadDocument {
  if (actions === undefined) throw new Error(`pluginSliceSeeds: no plan '${name}'`);
  const outcome = runPlan([...actions]);
  if (outcome.failedSteps.length > 0) throw new Error(`pluginSliceSeeds: plan '${name}' failed: ${outcome.failedSteps.join(' | ')}`);
  return outcome.document;
}

/** The implicit plan plus a sheet with a surface_uv gyroid and a strut lattice on it, so the mutations reach the cell maps. */
function implicitDocument(): CadDocument {
  const run = (doc: CadDocument, name: string, params: Record<string, unknown>): { document: CadDocument; id: string } => {
    const result = execute(doc, name, params);
    if (result.error !== undefined) throw new Error(`pluginSliceSeeds: ${name} refused: ${result.summary}`);
    return { document: result.document, id: result.affected[0] ?? '' };
  };
  const base = planDocument(implicitPlans['implicit_shell_gyroid_block'], 'implicit_shell_gyroid_block');
  const sheet = run(base, 'create_nurbs_surface', {
    degreeU: 1,
    degreeV: 1,
    poles: [
      [
        [0, 0, 0],
        [0, 20, 0],
      ],
      [
        [20, 0, 0],
        [20, 20, 0],
      ],
    ],
  });
  const map = { kind: 'surface_uv', sheetId: sheet.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 };
  const tpms = run(sheet.document, 'add_tpms_lattice', {
    kind: 'gyroid',
    form: 'sheet',
    thickness: 0.3,
    normalize: 'none',
    cellSize: 5,
    map,
  });
  return run(tpms.document, 'add_strut_lattice', { cell: 'cubic', cellSize: 5, radius: 0.4, map }).document;
}

/** The house template plus a vessel with a circular platform, a deck platform with railing and a braced pipe rack (06 STA M6 / M7 assemblies: parts with assemblyId, host links). */
function buildingWithPlatforms(): CadDocument {
  const house = planDocument(plans['building_house_template'], 'building_house_template');
  const scale = house.units === 'm' ? 0.001 : 1;
  const mm = (value: number): number => value * scale;
  const run = (doc: CadDocument, name: string, params: Record<string, unknown>): { document: CadDocument } => {
    const result = execute(doc, name, params);
    if (result.error !== undefined) throw new Error('pluginSliceSeeds: ' + name + ' refused: ' + result.summary);
    return result;
  };
  const vessel = run(house, 'add_equipment', {
    name: 'Column',
    location: [mm(40000), 0],
    size: [mm(2000), mm(2000), mm(8000)],
    shape: 'vertical_vessel',
  });
  const ring = run(vessel.document, 'add_circular_access_platform', {
    equipmentId: 'equipment-1',
    elevation: mm(3000),
    width: mm(800),
    railing: {},
  });
  const deck = run(ring.document, 'add_access_platform', {
    bounds: [
      [mm(50000), 0],
      [mm(53000), mm(2000)],
    ],
    gratingType: '19-W-4 1-1/4x3/16',
    bearingBarDirection: [1, 0],
    railing: {},
  });
  return run(deck.document, 'add_pipe_rack', {
    origin: [mm(60000), 0],
    direction: [1, 0],
    length: mm(6000),
    bentSpacing: mm(3000),
    width: mm(3000),
    tiers: [mm(2500)],
    columnProfile: 'HEB200',
    tierBeamProfile: 'IPE200',
    bracingBays: [1],
    bracingProfile: 'L100x10',
  }).document;
}

/** The platform building plus parametric equipment (06 EQP): a vessel, a heat exchanger, a storage tank and a pump with their nozzles and design data. */
function buildingWithEquipment(): CadDocument {
  const run = (doc: CadDocument, name: string, params: object): CadDocument => {
    const result = execute(doc, name, params);
    if (result.error !== undefined || result.rejected) throw new Error('pluginSliceSeeds: ' + name + ' refused: ' + result.summary);
    return result.document;
  };
  const withNozzles = (doc: CadDocument, tag: string, nozzles: readonly object[]): CadDocument =>
    nozzles.reduce<CadDocument>((next, nozzle) => run(next, 'add_nozzle', { equipment: tag, ...nozzle }), doc);
  let doc = run(buildingWithPlatforms(), 'add_vessel', { ...separatorParams, location: [0, 20000] });
  doc = withNozzles(doc, 'V-101', separatorNozzles);
  doc = run(doc, 'add_heat_exchanger', { ...bemParams, location: [15000, 20000] });
  doc = withNozzles(doc, 'E-301', bemNozzles);
  doc = run(doc, 'add_storage_tank', { ...tankParams, location: [60000, 30000] });
  return run(doc, 'add_pump', { ...pumpParams, location: [30000, 20000] });
}

const planOf = (table: Record<string, GoldenAction[]>, name: string) => (): CadDocument => planDocument(table[name], name);

/** The golden PLM plan needs a signature port that accepts a confirmation naming its signer (as tests/golden/golden.test.ts does). */
function plmDocument(): CadDocument {
  setSignaturePort({
    verify: (c) =>
      typeof c === 'object' && c !== null && 'as' in c ? { signer: String((c as { as: unknown }).as), signatureId: 'seed' } : null,
  });
  try {
    return planDocument(plmPlans['plm_release_eco'], 'plm_release_eco');
  } finally {
    setSignaturePort(null);
  }
}

const scanContext = (): ExecutionContext => ({ ...defaultContext(), pointClouds: fixturePort([{ key: KEY_A, points: [[0, 0, 0]] }]) });

function scanDocument(): CadDocument {
  const ctx = scanContext();
  const attached = execute({ ...createEmptyDocument(), units: 'm' }, 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  return execute(attached.document, 'set_scan_crop', { name: 'crop', min: [-1, -1, -1], max: [1, 1, 1] }, ctx).document;
}

function cfdDocument(): CadDocument {
  const body = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
  return ok(body.doc, 'create_cfd_case', caseParams([body.id])).document;
}

const analysisId = (doc: CadDocument): string => doc.analysis?.caseOrder[0] ?? 'missing';
const studyId = (doc: CadDocument): string => doc.analysis?.cases[analysisId(doc)]?.topologyOrder?.[0] ?? 'missing';

export const SLICE_SEEDS: Readonly<Record<string, PluginSliceSeed>> = {
  building: {
    roots: ['building'],
    build: buildingWithEquipment,
    query: { name: 'describe_building', params: constant({}) },
    mutate: { name: 'add_level', params: constant({ name: 'Fuzz level', elevation: 90000, height: 3000 }) },
  },
  civil: {
    roots: ['civil'],
    build: planOf(plans, 'civil_site_terrain_road_drainage'),
    query: { name: 'describe_civil', params: constant({}) },
    mutate: { name: 'set_coordinate_system', params: constant({ name: 'Fuzz CRS' }) },
  },
  piping: {
    roots: ['plant.piping'],
    build: planOf({ seed: [...(plans['piping_pump_to_vessel'] as GoldenAction[]), ...cappedRunSteps] }, 'seed'),
    query: { name: 'piping_takeoff', params: constant({}) },
    mutate: { name: 'set_piping_settings', params: constant({ lineNumberTemplate: '{dn}-{fluid}-{seq}-{class}' }) },
  },
  'piping-catalog': {
    roots: ['plant.catalog', 'plant.spec'],
    build: planOf(plans, 'piping_pump_to_vessel'),
    query: { name: 'list_piping_catalogs', params: constant({}) },
    mutate: { name: 'import_piping_catalog', params: constant({ catalog: rteJson('catalog_stub_cs150.json') }) },
  },
  pipeStress: {
    roots: ['plant.stress'],
    build: () => recordedModel().doc,
    query: { name: 'check_pipe_stress', params: (doc) => ({ modelId: first(doc.plant?.stress?.models) }) },
    mutate: { name: 'update_stress_model', params: (doc) => ({ modelId: first(doc.plant?.stress?.models), name: 'Fuzz' }) },
  },
  'plant-data': {
    roots: ['plant.data'],
    build: libraryDocument,
    query: { name: 'plant_data_table', params: constant({}) },
    mutate: { name: 'define_plant_hierarchy', params: constant({ nodes: [{ code: 'FZ', kind: 'site', name: 'Fuzz site' }] }) },
  },
  'piping-fabrication': {
    roots: ['plant.fabrication'],
    build: () => execute({ ...createEmptyDocument(), units: 'mm' }, 'import_pcf', { text: fixturePcf() }).document,
    query: { name: 'export_pcf', params: constant({}) },
    mutate: { name: 'import_pcf', params: constant({ text: fixturePcf(), lineIdOverride: 'FUZZ-1' }) },
  },
  pid: {
    roots: ['plant.pid'],
    build: () => runSteps(FEED_PUMP).doc,
    query: { name: 'pid_report', params: constant({ kind: 'connectivity' }) },
    mutate: { name: 'create_pid_sheet', params: constant({ number: 'PID-FUZZ' }) },
  },
  scan: {
    roots: ['scan'],
    build: scanDocument,
    ctx: scanContext,
    query: { name: 'check_point_clouds', params: constant({}) },
    mutate: { name: 'set_scan_crop', params: constant({ name: 'fuzz', min: [0, 0, 0], max: [1, 1, 1] }) },
  },
  cfd: {
    roots: ['cfd'],
    build: cfdDocument,
    query: { name: 'check_cfd', params: constant({}) },
    mutate: { name: 'create_cfd_case', params: (doc) => caseParams(Object.keys(doc.entities).slice(0, 1), { id: 'fuzz' }) },
  },
  composites: {
    roots: ['composites'],
    build: planOf(plans, 'composites_flat_panel'),
    query: { name: 'check_laminate_rules', params: (doc) => ({ part: first(doc.composites?.parts) }) },
    mutate: { name: 'set_laminate_rules', params: (doc) => ({ part: first(doc.composites?.parts), symmetric: true }) },
  },
  fasteners: {
    roots: ['fasteners'],
    build: () => docWith(),
    query: { name: 'list_fastener_families', params: constant({}) },
    mutate: { name: 'import_fastener_catalog', params: constant({ catalog: sampleCatalogFile(), replace: true }) },
  },
  sheetmetal: {
    roots: ['sheetMetal'],
    build: () => bracket().doc,
    query: { name: 'check_sheet_metal', params: constant({}) },
    mutate: { name: 'create_sheet_metal_rule', params: constant({ ...RULE, name: 'fuzz rule', relief: { ...RULE.relief } }) },
  },
  surfacing: {
    roots: ['aero'],
    build: planOf(plans, 'aero_naca_trap_wing'),
    mutate: { name: 'airfoil_from_naca', params: constant({ designation: '0012' }) },
  },
  cae: {
    roots: ['analysis'],
    build: planOf(plans, 'fea_modal_cantilever'),
    mutate: { name: 'create_analysis', params: constant({ name: 'fuzz analysis', analysisType: 'static' }) },
  },
  topology: {
    roots: ['analysis'],
    build: () => mbbModel().doc,
    query: { name: 'check_topology', params: (doc) => ({ studyId: studyId(doc) }) },
    mutate: { name: 'set_topology_settings', params: (doc) => ({ studyId: studyId(doc), penal: 3 }) },
  },
  explicit: {
    roots: ['analysis'],
    build: () => barModel().doc,
    query: { name: 'explicit_energy_check', params: (doc) => ({ analysisId: analysisId(doc) }) },
    mutate: { name: 'create_analysis', params: constant({ name: 'fuzz explicit', analysisType: 'explicit_dynamics' }) },
  },
  implicit: {
    roots: ['implicit'],
    build: implicitDocument,
    mutate: { name: 'create_scalar_field', params: constant({ kind: 'coordinate', axis: 'x' }) },
  },
  plm: {
    roots: ['plm'],
    build: plmDocument,
    query: { name: 'plm_status', params: constant({}) },
    mutate: { name: 'submit_for_review', params: constant({ comment: 'fuzz', at: '2026-11-02T10:00:00Z', by: 'u-0007' }) },
  },
};
