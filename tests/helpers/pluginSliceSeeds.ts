/**
 * One valid seed document per plugin that owns a document slice (tests/unit/contract/pluginSliceFuzz.test.ts). A new plugin with a
 * `document` extension MUST add its row here: the fuzz test fails naming a plugin without one. Seeds are built through real commands (golden /
 * oracle plans and unit fixtures); `pid` has no command yet, so its slice is written with the model's own `withPid`.
 */

import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setSignaturePort } from '@core/commands/signaturePort';
import type { ExecutionContext } from '@core/commands/types';
import type { PidItem, PidModel } from '@aec/plant/pid/model';
import { EMPTY_PID, withPid } from '@aec/plant/pid/state';
import { runPlan } from '../golden/runPlan';
import { plans, type GoldenAction } from '../golden/plans';
import { plmPlans } from '../golden/plmPlans';
import { implicitPlans } from '../golden/implicitPlans';
import { rteJson } from '../unit/plant/piping/rteFixtures';
import { libraryDocument } from '../unit/plant/data/dataFixtures';
import { fixturePcf } from '../unit/plant/fabrication/fabricationFixtures';
import { addBody, caseParams, metreDocument, ok } from '../unit/aero/cfd/fixtures';
import { docWith, sampleCatalogFile } from '../unit/aero/fasteners/fixtures';
import { bracket, RULE } from '../unit/aero/sheetmetal/helpers';
import { mbbModel } from '../unit/cae/topology/support';
import { barModel } from '../unit/cae/explicit/support';
import { fixturePort, KEY_A } from '../unit/scan/fixturePort';

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

const pidBase = { sheetId: 'pid-1.1', rotationDeg: 0, attributes: {} } as const;
const pidItems: PidItem[] = [
  { ...pidBase, id: 'pid-2.1', kind: 'equipment', at: [100, 100], dexpiClass: 'Tank', tag: 'T-101' },
  {
    ...pidBase,
    id: 'pid-2.3',
    kind: 'nozzle',
    at: [130, 100],
    dexpiClass: 'Nozzle',
    equipmentId: 'pid-2.1',
    subTag: 'N1',
    dn: 100,
    access: false,
    port: [130, 100],
  },
  {
    ...pidBase,
    id: 'pid-3.1',
    kind: 'line',
    at: [0, 0],
    dexpiClass: 'PipingNetworkSystem',
    lineNumber: '100-P-1001-A1A',
    dn: 100,
    pipingClass: 'A1A',
    fluidCode: 'P',
    segmentIds: ['pid-3.2'],
  },
  {
    ...pidBase,
    id: 'pid-3.2',
    kind: 'segment',
    at: [0, 0],
    dexpiClass: 'PipingNetworkSegment',
    lineId: 'pid-3.1',
    from: { type: 'nozzle', itemId: 'pid-2.3' },
    to: { type: 'free', at: [300, 100] },
    route: [
      [130, 100],
      [300, 100],
    ],
    flow: 'forward',
    dn: 100,
    primary: true,
  },
];
const pidModel: PidModel = {
  ...EMPTY_PID,
  sheets: { 'pid-1.1': { id: 'pid-1.1', number: 'PID-001', title: 'Feed', paper: 'A1', revision: 'A', status: 'draft' } },
  sheetOrder: ['pid-1.1'],
  items: Object.fromEntries(pidItems.map((item) => [item.id, item])),
  itemOrder: pidItems.map((item) => item.id),
  counters: { seq: 3 },
};

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
    build: planOf(plans, 'building_house_template'),
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
    build: planOf(plans, 'piping_pump_to_vessel'),
    query: { name: 'piping_takeoff', params: constant({}) },
    mutate: { name: 'set_piping_settings', params: constant({ lineNumberTemplate: '{dn}-{fluid}-{seq}-{class}' }) },
  },
  'piping-catalog': {
    roots: ['plant.catalog', 'plant.spec'],
    build: planOf(plans, 'piping_pump_to_vessel'),
    query: { name: 'list_piping_catalogs', params: constant({}) },
    mutate: { name: 'import_piping_catalog', params: constant({ catalog: rteJson('catalog_stub_cs150.json') }) },
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
  pid: { roots: ['plant.pid'], build: () => withPid(createEmptyDocument(), pidModel) },
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
    build: planOf(implicitPlans, 'implicit_shell_gyroid_block'),
    mutate: { name: 'create_scalar_field', params: constant({ kind: 'coordinate', axis: 'x' }) },
  },
  plm: {
    roots: ['plm'],
    build: plmDocument,
    query: { name: 'plm_status', params: constant({}) },
    mutate: { name: 'submit_for_review', params: constant({ comment: 'fuzz', at: '2026-11-02T10:00:00Z', by: 'u-0007' }) },
  },
};
