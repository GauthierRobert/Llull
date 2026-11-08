/**
 * PHY-06 M3 fixtures: a 1 x 1 x 4 bolt (steel) capped by a 1 x 1 x 1 plate, in a nonlinear_static case with a contact pair between the plate
 * bottom (slave) and the bolt top (master), two fixed ends, one preload step; the Kuhn-tet mesh (6 tets per cube, 4 + 1 cubes) and frd text.
 */
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { hashOf, portOf } from '../deckFixtures';
import { must } from './support';

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/contact' };

export interface Bolted {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly bolt: string;
  readonly plate: string;
  readonly stepId: string;
  readonly bottomId: string;
  readonly topId: string;
  readonly pairId: string | null;
}

/** Bolt z 0..4 and plate z 4..5; steel; fixed bottom (bolt z = 0) and top (plate z = 5); one load step (no external load); nlgeom false. */
export function bolted(options: { readonly pair?: boolean } = {}): Bolted {
  let doc = createEmptyDocument();
  const boltBox = must(doc, 'add_box', { size: [1, 1, 4], position: [0, 0, 0], anchor: 'min' });
  const plateBox = must(boltBox.doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 4], anchor: 'min' });
  const [bolt = '', plate = ''] = [boltBox.affected[0], plateBox.affected[0]];
  doc = must(plateBox.doc, 'create_material', { name: 'steel', density: 0.00785, color: '#999999', metalness: 1, roughness: 0.4 }).doc;
  doc = must(doc, 'add_material_model', {
    material: 'steel',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 200, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
    basis: 'unspecified',
    source: SOURCE,
  }).doc;
  doc = must(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true }).doc;
  doc = must(doc, 'assign_material', { materialName: 'steel', entityIds: [bolt, plate] }).doc;
  const created = must(doc, 'create_analysis', { name: 'joint', analysisType: 'nonlinear_static' });
  const analysisId = created.affected[0] ?? '';
  doc = created.doc;
  for (const entityId of [bolt, plate]) doc = must(doc, 'set_part_idealization', { analysisId, entityId }).doc;
  const bottom = must(doc, 'add_fea_constraint', {
    analysisId,
    name: 'bottom',
    kind: 'fixed',
    target: { entityId: bolt, facesNear: [[0.5, 0.5, 0]] },
  });
  const top = must(bottom.doc, 'add_fea_constraint', {
    analysisId,
    name: 'top',
    kind: 'fixed',
    target: { entityId: plate, facesNear: [[0.5, 0.5, 5]] },
  });
  doc = must(top.doc, 'set_nonlinear_controls', { analysisId, nlgeom: false, outputIncrements: 'all' }).doc;
  const step = must(doc, 'add_analysis_step', {
    analysisId,
    name: 'preload',
    multipliers: {},
    control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
  });
  doc = step.doc;
  let pairId: string | null = null;
  if (options.pair === true) {
    const pair = must(doc, 'add_contact_pair', {
      analysisId,
      name: 'cap',
      slave: { entityId: plate, facesNear: [[0.5, 0.5, 4]] },
      master: { entityId: bolt, facesNear: [[0.5, 0.5, 4]] },
      formulation: 'surface_to_surface',
      behaviour: { kind: 'linear', slope: 1e6 },
    });
    doc = pair.doc;
    pairId = pair.affected[1] ?? null;
  }
  return {
    doc,
    analysisId,
    bolt,
    plate,
    stepId: step.affected[0] ?? '',
    bottomId: bottom.affected[0] ?? '',
    topId: top.affected[0] ?? '',
    pairId,
  };
}

/** Section of the bolt at mid-height, axis +z. */
export const sectionParams = (b: Bolted, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  analysisId: b.analysisId,
  name: 'm1',
  entityId: b.bolt,
  section: { point: [0.5, 0.5, 2], normal: [0, 0, 1] },
  preload: { kind: 'force', value: 10 },
  preloadStepId: b.stepId,
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

/** Bolt nodes 1..20 at (i, j, k) with id 1 + i + 2j + 4k, k 0..4; plate nodes 21..28 at (i, j, 4 + k), id 21 + i + 2j + 4k. */
const NODES: FeMeshArtifact['nodes'] = [
  ...Array.from({ length: 20 }, (_, n) => [1 + n, n & 1, (n >> 1) & 1, n >> 2] as const),
  ...Array.from({ length: 8 }, (_, n) => [21 + n, n & 1, (n >> 1) & 1, 4 + (n >> 2)] as const),
];

/** Elements 1..24 (bolt, 6 per cube, bottom to top) and 25..30 (plate). */
const ELEMENTS: number[][] = [
  ...[0, 1, 2, 3].flatMap((cube) => TETS.map((tet, index) => [1 + 6 * cube + index, ...tet.map((node) => node + 4 * cube)])),
  ...TETS.map((tet, index) => [25 + index, ...tet.map((node) => node + 20)]),
];

/** (element, face) pairs whose three corners lie in `nodeIds`, among the elements `from`..`to`. */
function facesIn(nodeIds: readonly number[], from: number, to: number): [number, number][] {
  const on = new Set(nodeIds);
  return ELEMENTS.filter(([id = 0]) => id >= from && id <= to).flatMap(([id = 0, ...nodes]) =>
    FACES.flatMap((face, index) => (face.every((corner) => on.has(nodes[corner] ?? -1)) ? [[id, index + 1] as [number, number]] : [])),
  );
}

/** Mesh artifact of the current mesh inputs; `pairId` adds the contact face / node sets (slave plate bottom, master bolt top). */
export function boltedMesh(b: Bolted, doc: CadDocument): FeMeshArtifact {
  const faceSets: Record<string, [number, number][]> = {};
  const nodeSets: Record<string, number[]> = { [`C_${b.bottomId}`]: [1, 2, 3, 4], [`C_${b.topId}`]: [25, 26, 27, 28] };
  if (b.pairId !== null) {
    faceSets[`CP_${b.pairId}_S`] = facesIn([21, 22, 23, 24], 25, 30);
    faceSets[`CP_${b.pairId}_M`] = facesIn([17, 18, 19, 20], 19, 24);
    nodeSets[`CP_${b.pairId}_S`] = [21, 22, 23, 24];
    nodeSets[`CP_${b.pairId}_M`] = [17, 18, 19, 20];
  }
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, b.analysisId, 'mesh'),
    nodes: NODES,
    blocks: [
      { type: 'C3D4', entityId: b.bolt, elements: ELEMENTS.slice(0, 24) },
      { type: 'C3D4', entityId: b.plate, elements: ELEMENTS.slice(24) },
    ],
    nodeSets,
    faceSets,
    targets: {},
  };
}

const cell = (value: number): string =>
  value
    .toExponential(5)
    .toUpperCase()
    .replace(/E([+-])(\d)$/, 'E$10$2')
    .padStart(12, ' ');

/** frd block of `components` with the node values (`values[node]` in component order). */
export function frdBlock(name: string, components: readonly string[], values: Readonly<Record<number, readonly number[]>>): string {
  return [
    ` -4  ${name.padEnd(8, ' ')}${String(components.length).padStart(4, ' ')}    1`,
    ...components.map((component, index) => ` -5  ${component.padEnd(8, ' ')}    1    1    ${index + 1}    0`),
    ...Object.keys(values).map((node) => ` -1${node.padStart(10, ' ')}${(values[Number(node)] ?? []).map(cell).join('')}`),
    ' -3',
  ].join('\n');
}

const STRESS = ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'] as const;

/** Stress block with the same tensor at the nodes in `nodeIds`, or `field(x, y, z)` per node when a function is given. */
export function stressBlock(
  tensor: (x: number, y: number, z: number) => readonly number[],
  nodeIds: readonly number[] = NODES.map(([id]) => id),
): string {
  return frdBlock(
    'STRESS',
    STRESS,
    Object.fromEntries(
      nodeIds.map((id) => [id, tensor(...((NODES.find(([node]) => node === id) ?? [0, 0, 0, 0]).slice(1) as [number, number, number]))]),
    ),
  );
}

/** Contact block `[COPEN, CSLIP1, CSLIP2, CPRESS, CSHEAR1, CSHEAR2]` at the plate-bottom nodes with the given pressure. */
export function contactBlock(pressure: number): string {
  return frdBlock(
    'CONTACT',
    ['COPEN', 'CSLIP1', 'CSLIP2', 'CPRESS', 'CSHEAR1', 'CSHEAR2'],
    Object.fromEntries([21, 22, 23, 24].map((node) => [node, [0, 0, 0, pressure, 0, 0]])),
  );
}

/** One frd result set (`100CL` header + its blocks): CalculiX step `step`, total time `time`, `increment` within the step. */
export function frdSet(step: number, time: number, blocks: readonly string[], increment = 1): string {
  return [
    `    1PSTEP                         ${step}           ${increment}           ${step}`,
    `  100CL  101${time.toExponential(5).toUpperCase().padStart(12, ' ')}${String(NODES.length).padStart(12, ' ')}                     1    ${step}           1`,
    ...blocks,
  ].join('\n');
}

export interface SolvedBolted {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/** `doc` meshed and solved with the frd sets given and the `.dat` tables (`dat`), recorded through the record commands. */
export function solveBolted(b: Bolted, doc: CadDocument, frd: string, dat?: FeResultsArtifact['dat']): SolvedBolted {
  const mesh = boltedMesh(b, doc);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, b.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(frd),
    ...(dat === undefined ? {} : { dat }),
  };
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = must(doc, 'record_fe_mesh', { analysisId: b.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
  const summary = resultsSummary(meshed.doc, b.analysisId, mesh, results, hashOf(results));
  const recorded = must(meshed.doc, 'record_fea_results', { analysisId: b.analysisId, summary }, ctx);
  return { doc: recorded.doc, ctx, mesh, results };
}
