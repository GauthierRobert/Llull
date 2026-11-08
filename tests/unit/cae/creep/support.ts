/** PHY-11 fixtures: the unit cube (6 tets) of VC-CRP-40 with a Norton material, a creep analysis around it, its mesh and synthetic frd text. */
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { facesOn, hashOf, portOf } from '../deckFixtures';
import { must } from '../contact/support';

export { must };

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/creep' };

export interface CreepCube {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly cube: string;
  readonly loadId: string;
  readonly symmetryIds: readonly string[];
}

export interface CubeOptions {
  /** `creep_norton` parameters (default A 1e-10, n 5, m 0, MPa, s, time hardening). */
  readonly law?: Record<string, unknown>;
  readonly basis?: 'company' | 'typical';
  readonly validityK?: readonly [number, number];
  readonly elastic?: 'isotropic' | 'orthotropic' | 'none';
  readonly creep?: boolean;
  readonly step?: Record<string, unknown> | null;
  readonly probes?: readonly { readonly name: string; readonly quantity: string }[];
  readonly type?: string;
}

/** The creep set-up of VC-CRP-40: 20 MPa tension on the top face, symmetry on the three planes, 1000 s hold at 293 K. */
export const STEP = {
  duration: { value: 1000, unit: 's' },
  initialIncrement: { value: 0.1, unit: 's' },
  cetol: 1e-3,
  maxIncrements: 1000,
  preloadStep: true,
  temperature: { value: 293, unit: 'K' },
} as const;

export function creepCube(options: CubeOptions = {}): CreepCube {
  let doc = createEmptyDocument();
  const box = must(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
  const cube = box.affected[0] ?? '';
  doc = must(box.doc, 'create_material', { name: 'norton', density: 0.0078, color: '#9aa0a6', metalness: 1, roughness: 0.4 }).doc;
  const elastic = options.elastic ?? 'isotropic';
  if (elastic === 'isotropic')
    doc = must(doc, 'add_material_model', {
      material: 'norton',
      id: 'el',
      model: { kind: 'elastic_isotropic', E: { value: 210000, unit: 'MPa' }, nu: { value: 0.3, unit: '1' } },
      validity: [{ variable: 'T', unit: 'K', data: [200, 900] }],
      basis: 'company',
      source: SOURCE,
    }).doc;
  if (elastic === 'orthotropic')
    doc = must(doc, 'add_material_model', {
      material: 'norton',
      id: 'el',
      model: {
        kind: 'elastic_orthotropic',
        E1: { value: 210000, unit: 'MPa' },
        E2: { value: 200000, unit: 'MPa' },
        E3: { value: 190000, unit: 'MPa' },
        nu12: { value: 0.3, unit: '1' },
        nu13: { value: 0.3, unit: '1' },
        nu23: { value: 0.3, unit: '1' },
        G12: { value: 80000, unit: 'MPa' },
        G13: { value: 80000, unit: 'MPa' },
        G23: { value: 80000, unit: 'MPa' },
      },
      validity: [{ variable: 'T', unit: 'K', data: [200, 900] }],
      basis: 'company',
      source: SOURCE,
    }).doc;
  if (options.creep !== false) {
    doc = must(doc, 'add_material_model', {
      material: 'norton',
      id: 'creep',
      model: { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 's', hardening: 'time', ...options.law },
      validity: [{ variable: 'T', unit: 'K', data: options.validityK ?? [293, 293] }],
      basis: options.basis ?? 'company',
      source: SOURCE,
    }).doc;
    doc = must(doc, 'define_constitutive_set', {
      material: 'norton',
      set: { id: 'cr', elastic: 'el', creep: 'creep' },
      makeDefault: true,
    }).doc;
  } else if (elastic !== 'none')
    doc = must(doc, 'define_constitutive_set', { material: 'norton', set: { id: 'el', elastic: 'el' }, makeDefault: true }).doc;
  doc = must(doc, 'assign_material', { materialName: 'norton', entityIds: [cube] }).doc;
  const created = must(doc, 'create_analysis', { name: 'norton_cube_creep', analysisType: options.type ?? 'creep' });
  const analysisId = created.affected[0] ?? '';
  doc = must(created.doc, 'set_part_idealization', { analysisId, entityId: cube }).doc;
  const symmetryIds: string[] = [];
  for (const [name, point] of [
    ['x0', [0, 0.5, 0.5]],
    ['y0', [0.5, 0, 0.5]],
    ['z0', [0.5, 0.5, 0]],
  ] as const) {
    const added = must(doc, 'add_fea_constraint', { analysisId, name, kind: 'symmetry', target: { entityId: cube, facesNear: [point] } });
    doc = added.doc;
    symmetryIds.push(added.affected[0] ?? '');
  }
  const load = must(doc, 'add_fea_load', {
    analysisId,
    name: 'tension',
    kind: 'pressure',
    loadCase: 'LC1',
    category: 'limit',
    target: { entityId: cube, facesNear: [[0.5, 0.5, 1]] },
    magnitude: -20,
  });
  doc = load.doc;
  if (options.step !== null && (options.type ?? 'creep') === 'creep')
    doc = must(doc, 'set_creep_step', { analysisId, ...STEP, ...options.step }).doc;
  for (const probe of options.probes ?? [])
    doc = must(doc, 'add_result_probe', { analysisId, name: probe.name, point: [0.5, 0.5, 0.5], quantity: probe.quantity }).doc;
  return { doc, analysisId, cube, loadId: load.affected[0] ?? '', symmetryIds };
}

const TETS = [
  [1, 2, 4, 8],
  [1, 6, 2, 8],
  [1, 4, 3, 8],
  [1, 3, 7, 8],
  [1, 5, 6, 8],
  [1, 7, 5, 8],
] as const;

/** The cube mesh: node 1 + i + 2j + 4k at (i, j, k); faces of the top (z = 1, nodes 5-8) for the load; the three symmetry node sets. */
export function cubeMesh(c: CreepCube, doc: CadDocument = c.doc): FeMeshArtifact {
  const [x0, y0, z0] = c.symmetryIds;
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, c.analysisId, 'mesh'),
    nodes: Array.from({ length: 8 }, (_, n) => [n + 1, n & 1, (n >> 1) & 1, n >> 2] as const),
    blocks: [{ type: 'C3D4', entityId: c.cube, elements: TETS.map((tet, index) => [index + 1, ...tet]) }],
    nodeSets: { [`C_${x0}`]: [1, 3, 5, 7], [`C_${y0}`]: [1, 2, 5, 6], [`C_${z0}`]: [1, 2, 3, 4] },
    faceSets: { [`L_${c.loadId}`]: facesOn([5, 6, 7, 8]) },
    targets: {},
  };
}

const cell = (value: number): string =>
  value
    .toExponential(5)
    .toUpperCase()
    .replace(/E([+-])(\d)$/, 'E$10$2')
    .padStart(12, ' ');

export interface FrdSet {
  /** CalculiX step number. */
  readonly step: number;
  /** CalculiX total time. */
  readonly time: number;
  /** Uniform nodal values: stress szz (MPa), uz (mm) at the top nodes and PE (creep strain). */
  readonly szz: number;
  readonly uz?: number;
  readonly ceeq: number;
}

/** frd text of `sets`: per set a DISP, STRESS and PE block at the eight nodes (uniform fields, CalculiX 12-column layout). */
export function creepFrd(sets: readonly FrdSet[]): string {
  const nodes = [1, 2, 3, 4, 5, 6, 7, 8];
  const block = (name: string, components: readonly string[], row: (node: number) => number[]): string[] => [
    ` -4  ${name.padEnd(8, ' ')}${String(components.length).padStart(5, ' ')}    1`,
    ...components.map((component, index) => ` -5  ${component.padEnd(8, ' ')}    1    1    ${index + 1}    0`),
    ...nodes.map((node) => ` -1${String(node).padStart(10, ' ')}${row(node).map(cell).join('')}`),
    ' -3',
  ];
  return sets
    .flatMap((set, index) => [
      `    1PSTEP                         ${index + 1}           1           ${set.step}`,
      `  100CL  ${String(101 + index).padStart(3, ' ')}${set.time.toPrecision(10).padStart(12, ' ')}${String(nodes.length).padStart(12, ' ')}                     0    ${set.step}           1`,
      ...block('DISP', ['D1', 'D2', 'D3'], (node) => [0, 0, node > 4 ? (set.uz ?? 0) : 0]),
      ...block('STRESS', ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], () => [0, 0, set.szz, 0, 0, 0]),
      ...block('PE', ['PE'], () => [set.ceeq]),
    ])
    .join('\n');
}

export interface SolvedCube {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/** `c.doc` meshed and solved with `frd` (results recorded through the record commands, artifacts in the port). */
export function solveCube(c: CreepCube, frd: string, doc: CadDocument = c.doc): SolvedCube {
  const mesh = cubeMesh(c, doc);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, c.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(frd),
  };
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = must(doc, 'record_fe_mesh', { analysisId: c.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
  const summary = resultsSummary(meshed.doc, c.analysisId, mesh, results, hashOf(results));
  const recorded = must(meshed.doc, 'record_fea_results', { analysisId: c.analysisId, summary }, ctx);
  return { doc: recorded.doc, ctx, mesh, results };
}

/** The VC-CRP-40 hold: preload set at 1e-3 s (step 1) and hold sets whose creep strain is A sigma^n t (ε = 3.2e-4 per second at 20 MPa). */
const HOLD_TIMES = [1, 10, 100, 1000] as const;
export const holdFrd = (preloadPeriodS: number, ceeqAt: (t: number) => number = (t) => 3.2e-4 * t): string =>
  creepFrd([...HOLD_TIMES.map((t) => ({ step: 2, time: preloadPeriodS + t, szz: 20, uz: 9.5e-5 + ceeqAt(t), ceeq: ceeqAt(t) }))]);
