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
import { blindRunSteps } from '../golden/pipingPlansBlind';
import { cappedRunSteps } from '../golden/pipingPlansCap';
import { rteJson } from '../unit/plant/piping/rteFixtures';
import { recordedModel } from '../unit/plant/stress/m3Fixtures';
import { libraryDocument } from '../unit/plant/data/dataFixtures';
import { fixturePcf } from '../unit/plant/fabrication/fabricationFixtures';
import { addBody, caseParams, metreDocument, ok } from '../unit/aero/cfd/fixtures';
import { docWith, sampleCatalogFile } from '../unit/aero/fasteners/fixtures';
import { bracket, RULE } from '../unit/aero/sheetmetal/helpers';
import { mbbModel } from '../unit/cae/topology/support';
import { blocks, must, pairParams } from '../unit/cae/contact/support';
import { creepCube, holdFrd, solveCube } from '../unit/cae/creep/support';
import { barModel } from '../unit/cae/explicit/support';
import { implicitAnalysis } from '../unit/cae/fieldMeshFixtures';
import { dtStudyBar, orderStudyBar, recordKind } from '../unit/cae/vnv/kindFixtures';
import { recordedStudy, studyBar } from '../unit/cae/vnv/studyFixtures';
import { fixturePort, KEY_A } from '../unit/scan/fixturePort';
import { flatDocument } from '../unit/vibroacoustics/fixtures';
import { missionDocument } from '../unit/environment/fixtures';
import { quadDrone, rotorParams } from '../unit/flight/flightFixture';
import { SOURCE_TEXT, imperfectBar } from '../unit/cae/nonlinear/imperfectionFixtures';
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

/** Pump-to-vessel plus a capped run and a blind-flanged line with a flanged joint and an instrument, plus a run that continues from the open end of another (a `runEnd` ref: a capped end must never be one). */
function pipingSeedDocument(): CadDocument {
  const base = planDocument([...(plans['piping_pump_to_vessel'] as GoldenAction[]), ...cappedRunSteps, ...blindRunSteps], 'piping seed');
  const piping = base.plant?.piping;
  const capped = piping?.runOrder.at(-1);
  const line = capped === undefined ? undefined : piping?.runs[capped]?.lineId;
  if (piping === undefined || capped === undefined || line === undefined) return base;
  const open = execute(base, 'route_pipe', {
    lineId: line,
    from: { point: [3000, 0, 0], direction: [1, 0, 0] },
    legs: [{ direction: '+X', length: 500 }],
  });
  const openRun = open.affected[0];
  if (openRun === undefined) throw new Error(`pluginSliceSeeds: piping seed route refused: ${open.summary}`);
  const next = execute(open.document, 'route_pipe', {
    lineId: line,
    from: { portId: `${openRun}:end` },
    legs: [{ direction: '+X', length: 400 }],
  });
  if (next.rejected === true) throw new Error(`pluginSliceSeeds: piping seed continuation refused: ${next.summary}`);
  return next.document;
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

/** The scan document with a valid acceptance ledger entry per act and one bound to another document uid. */
function scanWithLedger(): CadDocument {
  const doc = scanDocument();
  const entry = {
    act: 'accept_registration' as const,
    targetId: 'reg-1.1',
    payload: 'a'.repeat(64),
    signer: 's',
    signatureId: 'id',
    signature: { alg: 'Ed25519', keyId: 'k-1', publicKey: 'a'.repeat(64), signature: 'b'.repeat(128), nonce: 'n-1' },
    documentUid: doc.uid ?? '',
  };
  const acceptanceLedger = [
    entry,
    { ...entry, act: 'accept_asbuilt_extraction' as const, targetId: 'ext-1.1' },
    { ...entry, documentUid: 'e'.repeat(32) },
  ];
  return { ...doc, scan: { ...(doc.scan as NonNullable<CadDocument['scan']>), acceptanceLedger } };
}

function cfdDocument(): CadDocument {
  const body = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
  return ok(body.doc, 'create_cfd_case', caseParams([body.id])).document;
}

/** The 05 bar with a verified convergence study (PHY-00 VNV-M3): the cae slice with its studies, behind an in-memory artifact port. */
let lsqSeed: ReturnType<typeof studyBar> | undefined;
const lsqFixture = (): ReturnType<typeof studyBar> => (lsqSeed ??= studyBar({ cells: [8, 4, 2, 1] }));
let dtSeed: ReturnType<typeof dtStudyBar> | undefined;
const dtFixture = (): ReturnType<typeof dtStudyBar> => (dtSeed ??= dtStudyBar());
let orderSeed: ReturnType<typeof orderStudyBar> | undefined;
const orderFixture = (): ReturnType<typeof orderStudyBar> => (orderSeed ??= orderStudyBar());
let studySeed: ReturnType<typeof studyBar> | undefined;
const studyFixture = (): ReturnType<typeof studyBar> => (studySeed ??= studyBar());

const analysisId = (doc: CadDocument): string => doc.analysis?.caseOrder[0] ?? 'missing';
/** PHY-06: two stacked cubes with a surface_to_surface pair (friction, activeSteps) and a torque-preloaded bolt section in a nonlinear_static case. */
function contactDocument(): CadDocument {
  const b = blocks({ holdUpper: true });
  const paired = must(
    b.doc,
    'add_contact_pair',
    pairParams(b, { friction: { mu: 0.2 }, activeSteps: [b.stepId], adjust: { kind: 'clearance', value: 0.01 } }),
  ).doc;
  return must(paired, 'add_bolt_pretension', {
    analysisId: b.analysisId,
    name: 'm1',
    entityId: b.lower,
    section: { point: [0.5, 0.5, 0.5], normal: [0, 0, 1] },
    preload: { kind: 'torque', torque: 5, diameter: 0.5, nutFactor: 0.2, nutFactorSource: 'synthetic seed' },
    preloadStepId: b.stepId,
    lockAfter: false,
  }).doc;
}

/** PHY-05 NLS-M3: the nonlinear bar (first case) with a buckling-mode imperfection pinned to the solved buckling case. */
let imperfectSeed: { doc: CadDocument; ctx: ExecutionContext } | undefined;
function imperfectFixture(): { doc: CadDocument; ctx: ExecutionContext } {
  if (imperfectSeed !== undefined) return imperfectSeed;
  const bar = imperfectBar();
  const added = execute(bar.doc, 'add_imperfection', {
    analysisId: bar.analysisId,
    fromAnalysisId: bar.bucklingId,
    modes: [{ mode: 1, amplitude: 0.5 }],
    amplitudeSource: SOURCE_TEXT,
  });
  if (added.error !== undefined) throw new Error(added.summary);
  imperfectSeed = { doc: added.document, ctx: bar.ctx };
  return imperfectSeed;
}
const studyId = (doc: CadDocument): string => doc.analysis?.cases[analysisId(doc)]?.topologyOrder?.[0] ?? 'missing';

/** `doc` with a valid human-act ledger entry and a copy bound to another document uid, in both ledgers, plus the matching fit dispositions. */
function withLedgers(doc: CadDocument): CadDocument {
  // the shape a real key produces: the exception kind carries a signer-chosen nonce, the payload kind (fit, margin) none
  const keyed = { alg: 'Ed25519', keyId: 'k-1', publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) };
  const signature = { ...keyed, nonce: 'n-1' };
  const exception = {
    analysisId: analysisId(doc),
    studyId: 'cs-1.1',
    code: 'VNV_NOT_ASYMPTOTIC',
    justification: 'j',
    signer: 's',
    signatureId: 'id',
    signature,
    levelHashes: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
    documentUid: doc.uid ?? '',
  };
  const fit = {
    decision: 'accepted',
    justification: 'j',
    inputsHash: 'h',
    signer: 's',
    signatureId: 'id',
    signature: keyed,
    documentUid: doc.uid ?? '',
  };
  const margin = {
    act: 'dispose_margin',
    analysisId: analysisId(doc),
    rowKey: 'k1',
    decision: 'accepted',
    justification: 'j',
    resultsHash: 'a'.repeat(64),
    signer: 's',
    signatureId: 'id',
    signature: keyed,
    documentUid: doc.uid ?? '',
  };
  const analysis = {
    ...doc.analysis,
    exceptionLedger: [exception, { ...exception, documentUid: 'e'.repeat(32) }],
    fitDispositions: { 'row 1': fit },
    fitLedger: [
      { ...fit, rowKey: 'row 1' },
      { ...fit, rowKey: 'row 1', documentUid: 'e'.repeat(32) },
    ],
    dispositionLedger: [
      margin,
      { ...margin, act: 'dispose_thermal_limit', rowKey: 'lim-1:max' },
      { ...margin, documentUid: 'e'.repeat(32) },
    ],
  };
  return { ...doc, analysis } as CadDocument;
}

export const SLICE_SEEDS: Readonly<Record<string, PluginSliceSeed>> = {
  'physics-environment': {
    roots: ['spaceEnvironment'],
    build: missionDocument,
    query: { name: 'check_space_environment', params: constant({ profile: 'nasa_gsfc_screening' }) },
    mutate: { name: 'set_mission_environment', params: constant({ aoFluence: { value: 2e21, unit: 'atoms/cm^2', source: 'fuzz' } }) },
  },
  'physics-vibroacoustics': {
    roots: ['vibroacoustics'],
    build: flatDocument,
    query: { name: 'acoustic_spectrum_report', params: constant({ spectrum: 'flat130' }) },
    mutate: { name: 'convert_acoustic_spectrum', params: constant({ spectrum: 'flat130', to: 'octave', name: 'fuzz_octave' }) },
  },
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
    build: pipingSeedDocument,
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
  // the acceptance ledger replays keep (accept_registration / accept_asbuilt_extraction)
  'scan#ledger': {
    roots: ['scan'],
    build: scanWithLedger,
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
  // 14 FLL-M1: an implicit body (with its material) analysed with mesh source implicit_field
  'cae#field-mesh': {
    roots: ['analysis', 'implicit'],
    build: () => implicitAnalysis().doc,
    mutate: { name: 'set_mesh_controls', params: (doc) => ({ analysisId: analysisId(doc), source: 'geometry' }) },
  },
  // a second seed of the same plugin (`<plugin>#<variant>`): the analysis slice with a verified convergence study (PHY-00 VNV-M3)
  'cae#studies': {
    roots: ['analysis'],
    build: () => recordedStudy(studyFixture()).doc,
    ctx: () => studyFixture().ctx,
    query: { name: 'check_verification', params: (doc) => ({ analysisId: analysisId(doc), gciTarget: 0.05 }) },
    mutate: {
      name: 'delete_convergence_study',
      params: (doc) => ({
        analysisId: analysisId(doc),
        studyId: Object.keys(doc.analysis?.cases[analysisId(doc)]?.studies ?? {})[0] ?? 'missing',
      }),
    },
  },
  // PHY-00 VNV-M4: a least-squares (4 levels), a time-step (dt) and an element-order (p) study
  'cae#studies-lsq': {
    roots: ['analysis'],
    build: () => recordedStudy(lsqFixture()).doc,
    ctx: () => lsqFixture().ctx,
    query: { name: 'check_verification', params: (doc) => ({ analysisId: analysisId(doc), gciTarget: 0.05 }) },
    mutate: {
      name: 'delete_convergence_study',
      params: (doc) => ({
        analysisId: analysisId(doc),
        studyId: Object.keys(doc.analysis?.cases[analysisId(doc)]?.studies ?? {})[0] ?? 'missing',
      }),
    },
  },
  'cae#imperfection': {
    roots: ['analysis'],
    build: () => imperfectFixture().doc,
    ctx: () => imperfectFixture().ctx,
    query: { name: 'check_analysis', params: (doc) => ({ analysisId: analysisId(doc) }) },
    mutate: {
      name: 'delete_imperfection',
      params: (doc) => ({
        analysisId: analysisId(doc),
        imperfectionId: doc.analysis?.cases[analysisId(doc)]?.nonlinear?.imperfectionOrder?.[0] ?? 'missing',
      }),
    },
  },
  'cae#studies-dt': {
    roots: ['analysis'],
    build: () => recordKind(dtFixture()).doc,
    ctx: () => dtFixture().ctx,
    query: { name: 'check_verification', params: (doc) => ({ analysisId: analysisId(doc), gciTarget: 0.05 }) },
    mutate: {
      name: 'delete_convergence_study',
      params: (doc) => ({
        analysisId: analysisId(doc),
        studyId: Object.keys(doc.analysis?.cases[analysisId(doc)]?.studies ?? {})[0] ?? 'missing',
      }),
    },
  },
  'cae#studies-order': {
    roots: ['analysis'],
    build: () => recordKind(orderFixture()).doc,
    ctx: () => orderFixture().ctx,
    query: { name: 'check_verification', params: (doc) => ({ analysisId: analysisId(doc), gciTarget: 0.05 }) },
    mutate: {
      name: 'delete_convergence_study',
      params: (doc) => ({
        analysisId: analysisId(doc),
        studyId: Object.keys(doc.analysis?.cases[analysisId(doc)]?.studies ?? {})[0] ?? 'missing',
      }),
    },
  },
  // the human-act ledgers replays keep (exceptionLedger, fitLedger, dispositionLedger) and the fit dispositions: a valid entry and one signed for another document uid
  'cae#ledgers': {
    roots: ['analysis'],
    build: () => withLedgers(recordedStudy(studyFixture()).doc),
    ctx: () => studyFixture().ctx,
    query: { name: 'check_verification', params: (doc) => ({ analysisId: analysisId(doc), gciTarget: 0.05 }) },
    mutate: { name: 'create_analysis', params: constant({ name: 'fuzz ledger analysis', analysisType: 'static' }) },
  },
  // PHY-06 M2: the contact pairs of a nonlinear_static case
  'cae#contact': {
    roots: ['analysis'],
    build: contactDocument,
    query: { name: 'check_contact', params: (doc) => ({ analysisId: analysisId(doc) }) },
    mutate: { name: 'update_contact_pair', params: (doc) => ({ analysisId: analysisId(doc), pair: 'stack', friction: { mu: 0.3 } }) },
  },
  // PHY-11 M2: the hold and the recorded creep summary of a creep case
  'cae#creep': {
    roots: ['analysis'],
    build: () => {
      const c = creepCube({ probes: [{ name: 'centre', quantity: 'ceeq' }] });
      return solveCube(c, holdFrd(1e-3)).doc;
    },
    query: { name: 'check_creep', params: (doc) => ({ analysisId: analysisId(doc) }) },
    mutate: { name: 'delete_creep_step', params: (doc) => ({ analysisId: analysisId(doc) }) },
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
  dynamics: {
    roots: ['flight'],
    build: () => {
      const table = {
        points: [
          [0, 0.1, 0.05],
          [0.4, 0.06, 0.04],
        ],
        source: 'fuzz table',
        grade: 'B',
      };
      const steps: [string, Record<string, unknown>][] = [
        ['add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }],
        [
          'define_flight_scenario',
          {
            body: 'frame',
            controller: 'fc',
            durationS: 2,
            id: 'hover',
            setpoints: [{ t: 0 }, { t: 1, position: [0, 0, 1], yawDeg: 5 }],
            wind: { steady: [1, 0, 0], gusts: [{ startS: 0.5, durationS: 0.5, peak: [0, 2, 0] }] },
          },
        ],
        ['define_flight_scenario', { body: 'frame', durationS: 1, id: 'tumble', initialAngularVelocity: [0, 1, 0] }],
        ['add_rotor', rotorParams({ id: 'r-static', hub: [10, 0, 0], spinInertiaKgM2: 1e-5 })],
        [
          'add_rotor',
          {
            ...rotorParams({ id: 'r-table', spin: 'cw', table }),
            thrustCoefficient: undefined,
            powerCoefficient: undefined,
            source: undefined,
          },
        ],
        ['set_body_drag', { body: 'frame', cdaM2: [0.01, 0.02, 0.05] }],
        ['add_battery', { id: 'pack', cellsSeries: 4, capacityMah: 5000, internalResistanceOhm: 0.05, source: 'fuzz pack' }],
        [
          'add_flight_powertrain',
          {
            id: 'pt',
            battery: 'pack',
            rotors: ['r1', 'r2'],
            datasheet: {
              nominalVoltageV: 14.8,
              terminalResistanceOhm: 0.1,
              torqueConstantNmPerA: 0.0104,
              rotorInertiaKgM2: 1e-5,
              noLoadCurrentA: 0.5,
            },
            motorSource: 'fuzz motor',
          },
        ],
      ];
      return steps.reduce((doc, [name, params]) => execute(doc, name, params).document, quadDrone());
    },
    query: { name: 'inspect_dynamics', params: constant({}) },
    mutate: { name: 'set_body_drag', params: constant({ body: 'frame', cdaM2: [0.1, 0.1, 0.1] }) },
  },
};

type SeedStep = { name: string; params: Record<string, unknown>; as?: string };

/** One PMSM, one stepper and one induction motor (DRV-M4) on their own rotor, each with a drive that the validation cross-checks against the motor kind. */
function machineSteps(): SeedStep[] {
  const rotor = (id: string, x: number): SeedStep[] => [
    { name: 'add_cylinder', params: { radius: 5, height: 5, position: [x, 200, 0], axis: [0, 0, 1] }, as: `cyl_${id}` },
    { name: 'add_rigid_body', params: { entityIds: [`$cyl_${id}`], id: `rotor_${id}`, massKg: 0.01 } },
    {
      name: 'add_body_joint',
      params: { kind: 'revolute', child: `rotor_${id}`, parent: 'ground', anchor: [x, 200, 0], axis: [0, 0, 1], id: `j_${id}` },
    },
  ];
  const source = { name: 'seed sheet', grade: 'C' };
  return [
    ...rotor('p', 0),
    ...rotor('s', 50),
    ...rotor('i', 100),
    {
      name: 'add_motor',
      params: {
        joint: 'j_p',
        kind: 'pmsm',
        id: 'mp',
        pmsmDatasheet: {
          polePairs: 4,
          phaseResistanceOhm: 0.05,
          inductanceH: 0.0002,
          fluxLinkageWb: 0.01,
          rotorInertiaKgM2: 1e-5,
          busVoltageV: 24,
          peakCurrentA: 20,
          thermal: { rthWindingHousingKPerW: 1.9, rthHousingAmbientKPerW: 4.7, tauWindingS: 41.5, tauMotorS: 809, maxWindingC: 155 },
        },
        gearhead: { ratio: 3, efficiency: 0.9 },
        source,
      },
    },
    {
      name: 'add_motor',
      params: {
        joint: 'j_s',
        kind: 'stepper',
        id: 'ms',
        stepperDatasheet: {
          stepsPerRev: 200,
          holdingTorqueNm: 0.5,
          ratedCurrentA: 2,
          phaseResistanceOhm: 1.5,
          phaseInductanceH: 0.003,
          rotorInertiaKgM2: 1e-5,
          detentTorqueNm: 0.01,
          pullOutCurve: [
            [0, 0.5],
            [600, 0.2],
          ],
        },
        source,
      },
    },
    {
      name: 'add_motor',
      params: {
        joint: 'j_i',
        kind: 'induction',
        id: 'mi',
        inductionDatasheet: {
          polePairs: 2,
          ratedVoltageV: 230,
          ratedFrequencyHz: 50,
          statorResistanceOhm: 0.5,
          rotorResistanceOhm: 0.4,
          statorLeakageReactanceOhm: 1,
          rotorLeakageReactanceOhm: 1,
          magnetisingReactanceOhm: 40,
          ironLossResistanceOhm: 800,
          rotorInertiaKgM2: 0.2,
        },
        source,
      },
    },
    {
      name: 'add_motion_profile',
      params: { id: 'pp', quantity: 'position', unit: 'deg', segments: [{ kind: 'move', law: 'linear', to: 90, duration: 1 }] },
    },
    {
      name: 'add_motion_profile',
      params: { id: 'fp', quantity: 'frequency', unit: 'Hz', segments: [{ kind: 'move', law: 'linear', to: 50, duration: 2 }] },
    },
    { name: 'set_motor_drive', params: { motor: 'mp', mode: 'torque', profile: 'tq', currentLimitA: 15, busVoltageV: 48 } },
    { name: 'set_motor_drive', params: { motor: 'ms', mode: 'position', profile: 'pp', stepDivision: 4, currentLimitA: 1.5 } },
    { name: 'set_motor_drive', params: { motor: 'mi', mode: 'frequency', profile: 'fp' } },
  ];
}

/**
 * The drive data of `doc.dynamics` (PHY-23: datasheet motors with thermal data, profiles, drives, transmissions, joint physics, load schedules, reference series). Dynamics is a core slice, not a plugin extension, so it has no row in
 * SLICE_SEEDS; tests/unit/contract/pluginSliceFuzz.test.ts runs it with the targeted `driveMutations` as well.
 */
export const DYNAMICS_SEED: PluginSliceSeed = {
  roots: ['dynamics', 'flight'],
  build: () => {
    const steps: { name: string; params: Record<string, unknown>; as?: string }[] = [
      { name: 'add_cylinder', params: { radius: 5, height: 5, position: [0, 0, 0], axis: [0, 0, 1] }, as: 'cylinder' },
      { name: 'add_rigid_body', params: { entityIds: ['$cylinder'], id: 'rotor', massKg: 0.001 } },
      {
        name: 'add_body_joint',
        params: { kind: 'revolute', child: 'rotor', parent: 'ground', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'j' },
      },
      {
        name: 'add_motor',
        params: {
          joint: 'j',
          kind: 'dc',
          id: 'm',
          datasheet: {
            nominalVoltageV: 48,
            terminalResistanceOhm: 1.13,
            torqueConstantNmPerA: 0.0603,
            rotorInertiaKgM2: 1e-5,
            thermal: {
              rthWindingHousingKPerW: 1.9,
              rthHousingAmbientKPerW: 4.7,
              tauWindingS: 41.5,
              tauMotorS: 809,
              maxWindingC: 155,
              alphaPerK: 0.0039,
            },
          },
          gearhead: { ratio: 5, efficiency: 0.9 },
          source: { name: 'seed sheet', grade: 'C' },
        },
      },
      {
        name: 'add_motion_profile',
        params: {
          id: 'w',
          quantity: 'velocity',
          unit: 'rad/s',
          start: 1,
          segments: [
            { kind: 'move', law: 'cycloidal', to: 3, duration: 1 },
            { kind: 'dwell', duration: 1 },
          ],
        },
      },
      {
        name: 'add_motion_profile',
        params: {
          id: 'v',
          quantity: 'voltage',
          unit: 'V',
          segments: [
            {
              kind: 'table',
              points: [
                [0, 0],
                [1, 5],
              ],
              interpolation: 'monotone_cubic',
            },
          ],
        },
      },
      {
        name: 'set_motor_drive',
        params: { motor: 'm', mode: 'velocity', profile: 'w', gains: { kp: 0.1, ki: 1 }, sampleHz: 1000, target: 'j', feedforward: true },
      },
      { name: 'add_cylinder', params: { radius: 5, height: 5, position: [50, 0, 0], axis: [0, 0, 1] }, as: 'second' },
      { name: 'add_rigid_body', params: { entityIds: ['$second'], id: 'wheel', massKg: 0.01 } },
      {
        name: 'add_body_joint',
        params: { kind: 'revolute', child: 'wheel', parent: 'ground', anchor: [50, 0, 0], axis: [0, 0, 1], id: 'j2' },
      },
      { name: 'add_box', params: { size: [10, 10, 10], position: [0, 100, 0] }, as: 'third' },
      { name: 'add_rigid_body', params: { entityIds: ['$third'], id: 'nut', massKg: 0.1 } },
      {
        name: 'add_body_joint',
        params: { kind: 'prismatic', child: 'nut', parent: 'ground', anchor: [0, 100, 0], axis: [0, 0, 1], id: 'jn' },
      },
      {
        name: 'add_transmission',
        params: { kind: 'gear', driver: 'j', driven: 'j2', ratio: 2, efficiency: 0.95, efficiencyBack: 0.9, backlashDeg: 0.5, id: 'tg' },
      },
      { name: 'add_transmission', params: { kind: 'lead_screw', screw: 'j', nut: 'jn', leadMm: 5, meanDiameterMm: 10, mu: 0.1, id: 'ts' } },
      {
        name: 'set_joint_physics',
        params: {
          joint: 'j2',
          friction: {
            model: 'stribeck',
            staticNm: 0.02,
            coulombNm: 0.01,
            stribeckVelocity: 0.5,
            viscousNmsPerRad: 0.001,
            source: { name: 'seed', grade: 'C' },
          },
          limits: { min: -2, max: 2, stiffness: 10, restitution: 0.5 },
          armatureKgM2: 1e-6,
        },
      },
      {
        name: 'add_motion_profile',
        params: { id: 'tq', quantity: 'torque', unit: 'N*m', segments: [{ kind: 'sine', amplitude: 0.01, frequencyHz: 2, cycles: 2 }] },
      },
      { name: 'add_load_schedule', params: { joint: 'j', kind: 'torque', profile: 'tq', id: 'ls' } },
      {
        name: 'add_reference_data',
        params: {
          id: 'rs',
          series: { quantity: 'joint_velocity', target: 'j', times: [0, 0.5, 1], values: [0, 1, 2], uncertainty: 0.1 },
          source: 'seed bench log',
          grade: 'B',
          bandRel: 0.1,
        },
      },
      ...machineSteps(),
      // a rotor and a body drag on bodies of the drive model: mutations of doc.dynamics (a body deleted, made fixed, an id reused) meet them
      { name: 'add_rotor', params: rotorParams({ body: 'wheel', id: 'rt', hub: [50, 0, 0], spinInertiaKgM2: 1e-6 }) },
      { name: 'set_body_drag', params: { body: 'nut', cdaM2: [0.01, 0.01, 0.02] } },
    ];
    let doc = createEmptyDocument();
    const ids = new Map<string, string>();
    for (const step of steps) {
      let text = JSON.stringify(step.params);
      for (const [name, id] of ids) text = text.split(`$${name}`).join(id);
      const result = execute(doc, step.name, JSON.parse(text) as Record<string, unknown>);
      if (result.document === doc) throw new Error(`DYNAMICS_SEED: ${step.name}: ${result.summary}`);
      if (step.as !== undefined) ids.set(step.as, result.affected[0] ?? '');
      doc = result.document;
    }
    return doc;
  },
  query: { name: 'check_motor_data', params: constant({ motor: 'm' }) },
  mutate: { name: 'set_motor_drive', params: constant({ motor: 'm', mode: 'voltage', volts: 5 }) },
};
