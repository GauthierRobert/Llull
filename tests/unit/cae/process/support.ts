/** PHY-16 fixtures: a plate with a deposit on it (a box mesh of 6 tets per cell), an am_build_distortion case around them, its mesh and synthetic frd text. */
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { hashOf, portOf } from '../deckFixtures';
import { must } from '../contact/support';

export { must };

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/process' };

/** Cells along x, y and the z levels (plate levels first); the plate top is z = 0. */
const GRID = { nx: 4, ny: 1, zLevels: [-2, -1, 0, 0.5, 1, 1.5] as readonly number[] } as const;
const PLATE_CELLS = 2;
export const LAYER_HEIGHT = 0.5;
export const STRAIN = { exx: -0.002, eyy: 0, ezz: 0, source: 'test input (not a process datum)', calibrated: true } as const;

export interface AmBar {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly plate: string;
  readonly deposit: string;
  readonly clampId: string;
}

export interface BarOptions {
  /** Which steps of the set-up to run (default all but the release). */
  readonly setup?: boolean;
  readonly strain?: boolean;
  readonly release?: boolean;
  readonly type?: string;
  readonly elastic?: boolean;
}

/** A 4 x 1 mm plate (2 mm thick) with a 4 x 1 x 1.5 mm deposit on it, E 200 GPa, nu 0; clamp on the plate bottom; 3 layers of 0.5 mm. */
export function amBar(options: BarOptions = {}): AmBar {
  const { setup = true, strain = true, release = false } = options;
  let doc = createEmptyDocument();
  const plateBox = must(doc, 'add_box', { size: [4, 1, 2], position: [0, 0, -2], anchor: 'min' });
  const plate = plateBox.affected[0] ?? '';
  const depositBox = must(plateBox.doc, 'add_box', { size: [4, 1, 1.5], position: [0, 0, 0], anchor: 'min' });
  const deposit = depositBox.affected[0] ?? '';
  doc = must(depositBox.doc, 'create_material', { name: 'steel', density: 0.0078, color: '#9aa0a6', metalness: 1, roughness: 0.4 }).doc;
  if (options.elastic !== false) {
    doc = must(doc, 'add_material_model', {
      material: 'steel',
      id: 'el',
      model: { kind: 'elastic_isotropic', E: { value: 200000, unit: 'MPa' }, nu: { value: 0, unit: '1' } },
      basis: 'company',
      source: SOURCE,
    }).doc;
    doc = must(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'el', elastic: 'el' }, makeDefault: true }).doc;
  }
  doc = must(doc, 'assign_material', { materialName: 'steel', entityIds: [plate, deposit] }).doc;
  const created = must(doc, 'create_analysis', { name: 'layered_bar', analysisType: options.type ?? 'am_build_distortion' });
  const analysisId = created.affected[0] ?? '';
  doc = must(created.doc, 'set_part_idealization', { analysisId, entityId: plate }).doc;
  doc = must(doc, 'set_part_idealization', { analysisId, entityId: deposit }).doc;
  const clamp = must(doc, 'add_fea_constraint', {
    analysisId,
    name: 'plate_bottom',
    kind: 'fixed',
    target: { entityId: plate, facesNear: [[2, 0.5, -2]] },
  });
  doc = clamp.doc;
  if ((options.type ?? 'am_build_distortion') === 'am_build_distortion' && setup) {
    doc = must(doc, 'am_build_setup', { analysisId, buildDirection: [0, 0, 1], plateEntityId: plate, layerHeight: LAYER_HEIGHT }).doc;
    if (strain) doc = must(doc, 'set_inherent_strain', { analysisId, ...STRAIN }).doc;
    if (release)
      doc = must(doc, 'add_release_step', {
        analysisId,
        name: 'cut_plate',
        remove: ['plate'],
        support321: {
          points: [
            [2, 0, 0],
            [2, 1, 0],
            [0, 0, 0],
          ],
        },
      }).doc;
  }
  return { doc, analysisId, plate, deposit, clampId: clamp.affected[0] ?? '' };
}

/** The 6 tets of one cell (corner n = i + 2j + 4k of the cell, 0-based): the cube decomposition of the other mesh fixtures. */
const CELL_TETS = [
  [0, 1, 3, 7],
  [0, 5, 1, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 4, 5, 7],
  [0, 6, 4, 7],
] as const;

const nodeId = (i: number, j: number, k: number): number => 1 + i + (GRID.nx + 1) * (j + (GRID.ny + 1) * k);

/** Mesh of the bar: element ids run cell by cell (z slowest); the plate elements come first in their block. */
export function amMesh(bar: AmBar, doc: CadDocument = bar.doc): FeMeshArtifact {
  const nodes: [number, number, number, number][] = [];
  GRID.zLevels.forEach((z, k) => {
    for (let j = 0; j <= GRID.ny; j++) for (let i = 0; i <= GRID.nx; i++) nodes.push([nodeId(i, j, k), i, j, z]);
  });
  const plate: number[][] = [];
  const deposit: number[][] = [];
  let element = 1;
  for (let k = 0; k < GRID.zLevels.length - 1; k++)
    for (let j = 0; j < GRID.ny; j++)
      for (let i = 0; i < GRID.nx; i++) {
        const corner = (n: number): number => nodeId(i + (n & 1), j + ((n >> 1) & 1), k + (n >> 2));
        for (const tet of CELL_TETS) (k < PLATE_CELLS ? plate : deposit).push([element++, ...tet.map(corner)]);
      }
  const bottom: number[] = [];
  for (let j = 0; j <= GRID.ny; j++) for (let i = 0; i <= GRID.nx; i++) bottom.push(nodeId(i, j, 0));
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, bar.analysisId, 'mesh'),
    nodes,
    blocks: [
      { type: 'C3D4', entityId: bar.plate, elements: plate },
      { type: 'C3D4', entityId: bar.deposit, elements: deposit },
    ],
    nodeSets: { [`C_${bar.clampId}`]: bottom },
    faceSets: {},
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
  readonly time: number;
  /** Uniform szz stress (MPa) and a displacement uz of every node. */
  readonly szz: number;
  readonly uz: number;
}

/** frd text of `sets`: per set a DISP and a STRESS block at every node of `mesh` (uniform fields, CalculiX 12-column layout). */
export function amFrd(mesh: FeMeshArtifact, sets: readonly FrdSet[]): string {
  const ids = mesh.nodes.map((node) => node[0]);
  const block = (name: string, components: readonly string[], row: () => number[]): string[] => [
    ` -4  ${name.padEnd(8, ' ')}${String(components.length).padStart(5, ' ')}    1`,
    ...components.map((component, index) => ` -5  ${component.padEnd(8, ' ')}    1    1    ${index + 1}    0`),
    ...ids.map((node) => ` -1${String(node).padStart(10, ' ')}${row().map(cell).join('')}`),
    ' -3',
  ];
  return sets
    .flatMap((set, index) => [
      `    1PSTEP                         ${index + 1}           1           ${set.step}`,
      `  100CL  ${String(101 + index).padStart(3, ' ')}${set.time.toPrecision(10).padStart(12, ' ')}${String(ids.length).padStart(12, ' ')}                     0    ${set.step}           1`,
      ...block('DISP', ['D1', 'D2', 'D3'], () => [0, 0, set.uz]),
      ...block('STRESS', ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], () => [0, 0, set.szz, 0, 0, 0]),
    ])
    .join('\n');
}

export interface SolvedBar {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/** `bar.doc` meshed and solved with `frd` (recorded through the record commands, artifacts in the port). */
export function solveBar(bar: AmBar, frd: (mesh: FeMeshArtifact) => string, doc: CadDocument = bar.doc): SolvedBar {
  const mesh = amMesh(bar, doc);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(frd(mesh)),
  };
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = must(doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
  const summary = resultsSummary(meshed.doc, bar.analysisId, mesh, results, hashOf(results));
  const recorded = must(meshed.doc, 'record_fea_results', { analysisId: bar.analysisId, summary }, ctx);
  return { doc: recorded.doc, ctx, mesh, results };
}
