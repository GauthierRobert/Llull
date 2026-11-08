/** PHY-06 fixtures: two unit steel cubes stacked on z (lower 0..1, upper 1..2) in a nonlinear_static case, their 12-tet mesh and frd text. */
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { hashOf, portOf } from '../deckFixtures';

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/contact' };

/** `command` that must succeed: the new document and its affected ids. */
export function must(
  doc: CadDocument,
  command: string,
  params: Record<string, unknown>,
  ctx?: ExecutionContext,
): { doc: CadDocument; affected: string[] } {
  const result = execute(doc, command, params, ctx);
  if (result.rejected === true || result.error !== undefined) throw new Error(`${command}: ${result.summary}`);
  return { doc: result.document, affected: result.affected };
}

export interface Blocks {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly lower: string;
  readonly upper: string;
  readonly stepId: string;
  readonly fixedId: string;
  readonly loadId: string;
}

/** Two stacked cubes, steel (E 210 GPa, nu 0.3), lower bottom fixed, LC1 pressure 10 on the upper top, nlgeom false, one load step. */
export function blocks(options: { readonly holdUpper?: boolean } = {}): Blocks {
  let doc = createEmptyDocument();
  const lowerBox = must(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
  const upperBox = must(lowerBox.doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 1], anchor: 'min' });
  const [lower = '', upper = ''] = [lowerBox.affected[0], upperBox.affected[0]];
  doc = must(upperBox.doc, 'create_material', { name: 'steel', density: 0.00785, color: '#999999', metalness: 1, roughness: 0.4 }).doc;
  doc = must(doc, 'add_material_model', {
    material: 'steel',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
    basis: 'unspecified',
    source: SOURCE,
  }).doc;
  doc = must(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true }).doc;
  doc = must(doc, 'assign_material', { materialName: 'steel', entityIds: [lower, upper] }).doc;
  const created = must(doc, 'create_analysis', { name: 'stack', analysisType: 'nonlinear_static' });
  const analysisId = created.affected[0] ?? '';
  doc = created.doc;
  for (const entityId of [lower, upper]) doc = must(doc, 'set_part_idealization', { analysisId, entityId }).doc;
  const fixed = must(doc, 'add_fea_constraint', {
    analysisId,
    name: 'base',
    kind: 'fixed',
    target: { entityId: lower, facesNear: [[0.5, 0.5, 0]] },
  });
  doc = fixed.doc;
  if (options.holdUpper === true)
    doc = must(doc, 'add_fea_constraint', {
      analysisId,
      name: 'guide',
      kind: 'displacement',
      dofs: { ux: 0, uy: 0 },
      target: { entityId: upper, facesNear: [[0.5, 0.5, 2]] },
    }).doc;
  const load = must(doc, 'add_fea_load', {
    analysisId,
    name: 'press',
    kind: 'pressure',
    loadCase: 'LC1',
    magnitude: 10,
    target: { entityId: upper, facesNear: [[0.5, 0.5, 2]] },
  });
  doc = load.doc;
  doc = must(doc, 'set_nonlinear_controls', { analysisId, nlgeom: false, outputIncrements: 'last_per_step' }).doc;
  const step = must(doc, 'add_analysis_step', {
    analysisId,
    name: 'press',
    multipliers: { LC1: 1 },
    control: { kind: 'load', initialIncrement: 0.1, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
  });
  return {
    doc: step.doc,
    analysisId,
    lower,
    upper,
    stepId: step.affected[0] ?? '',
    fixedId: fixed.affected[0] ?? '',
    loadId: load.affected[0] ?? '',
  };
}

/** The usual pair: upper bottom face (slave) on lower top face (master). */
export const pairParams = (b: Blocks, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  analysisId: b.analysisId,
  name: 'stack',
  slave: { entityId: b.upper, facesNear: [[0.5, 0.5, 1]] },
  master: { entityId: b.lower, facesNear: [[0.5, 0.5, 1]] },
  formulation: 'surface_to_surface',
  behaviour: { kind: 'linear', slope: 1e6 },
  ...extra,
});

const TETS: readonly (readonly [number, number, number, number])[] = [
  [1, 2, 4, 8],
  [1, 6, 2, 8],
  [1, 4, 3, 8],
  [1, 3, 7, 8],
  [1, 5, 6, 8],
  [1, 7, 5, 8],
];
const FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
] as const;

/** Node ids of cube `c` (0 lower, 1 upper): 1 + 8c + i + 2j + 4k at (i, j, k + c), the upper cube shifted by `dz`. */
const cubeNodes = (c: number, dz: number): FeMeshArtifact['nodes'] =>
  Array.from({ length: 8 }, (_, n) => [1 + 8 * c + n, n & 1, (n >> 1) & 1, (n >> 2) + c + (c === 1 ? dz : 0)] as const);

/** Elements 1..6 (lower) and 7..12 (upper). */
const elementsOf = (c: number): number[][] => TETS.map((tet, index) => [1 + 6 * c + index, ...tet.map((node) => node + 8 * c)]);

/** (element, CalculiX face) pairs of cube `c` whose three corners lie in `nodeIds`. */
function cubeFaces(c: number, nodeIds: readonly number[]): [number, number][] {
  const on = new Set(nodeIds);
  const out: [number, number][] = [];
  elementsOf(c).forEach(([id = 0, ...nodes]) =>
    FACES.forEach((face, index) => {
      if (face.every((corner) => on.has(nodes[corner] ?? -1))) out.push([id, index + 1]);
    }),
  );
  return out;
}

const LOWER_TOP = [5, 6, 7, 8];
const UPPER_BOTTOM = [9, 10, 11, 12];
const UPPER_TOP = [13, 14, 15, 16];

/** Mesh artifact of the current mesh inputs with the contact face sets of `pairIds` (slave upper bottom, master lower top). */
export function blocksMesh(b: Blocks, doc: CadDocument, pairIds: readonly string[], dz = 0): FeMeshArtifact {
  const faceSets: Record<string, [number, number][]> = { [`L_${b.loadId}`]: cubeFaces(1, UPPER_TOP) };
  const nodeSets: Record<string, number[]> = { [`C_${b.fixedId}`]: [1, 2, 3, 4] };
  for (const id of pairIds) {
    faceSets[`CP_${id}_S`] = cubeFaces(1, UPPER_BOTTOM);
    faceSets[`CP_${id}_M`] = cubeFaces(0, LOWER_TOP);
    nodeSets[`CP_${id}_S`] = UPPER_BOTTOM;
    nodeSets[`CP_${id}_M`] = LOWER_TOP;
  }
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, b.analysisId, 'mesh'),
    nodes: [...cubeNodes(0, 0), ...cubeNodes(1, dz)],
    blocks: [
      { type: 'C3D4', entityId: b.lower, elements: elementsOf(0) },
      { type: 'C3D4', entityId: b.upper, elements: elementsOf(1) },
    ],
    nodeSets,
    faceSets,
    targets: {},
  };
}

/** CalculiX-style 12-column cell of a value (`-1.00000E-03`). */
const cell = (value: number): string => {
  const text = value
    .toExponential(5)
    .toUpperCase()
    .replace(/E([+-])(\d)$/, 'E$10$2');
  return text.padStart(12, ' ');
};

/** One frd result set: `1PSTEP`, `100CL` with the time, a CONTACT block of six components at the given nodes. */
export function frdContact(
  step: number,
  time: number,
  values: Readonly<Record<number, readonly number[]>>,
  components: readonly string[] = ['COPEN', 'CSLIP1', 'CSLIP2', 'CPRESS', 'CSHEAR1', 'CSHEAR2'],
  increment = 1,
): string {
  const nodes = Object.keys(values).map(Number);
  return [
    `    1PSTEP                         ${step}           ${increment}           ${step}`,
    `  100CL  101${time.toExponential(5).toUpperCase().padStart(12, ' ')}${String(nodes.length).padStart(12, ' ')}                     1    ${step}           1`,
    ` -4  CONTACT     ${components.length}    1`,
    ...components.map((name, index) => ` -5  ${name.padEnd(8, ' ')}    1    1    ${index + 1}    0`),
    ...nodes.map((node) => ` -1${String(node).padStart(10, ' ')}${(values[node] ?? []).map(cell).join('')}`),
    ' -3',
  ].join('\n');
}

export interface Solved {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/** `doc` meshed and solved with the given frd text (results recorded through the record commands, artifacts in the port). */
export function solve(b: Blocks, doc: CadDocument, pairIds: readonly string[], frd: string, dz = 0): Solved {
  const mesh = blocksMesh(b, doc, pairIds, dz);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, b.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(frd),
  };
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = must(doc, 'record_fe_mesh', { analysisId: b.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
  const summary = resultsSummary(meshed.doc, b.analysisId, mesh, results, hashOf(results));
  const recorded = must(meshed.doc, 'record_fea_results', { analysisId: b.analysisId, summary }, ctx);
  return { doc: recorded.doc, ctx, mesh, results };
}
