/** 05 FE fixtures: a 2 x 1 x 1 bar (6 tetrahedra, the mesh of the ccx reference runs in fixtures/) with a static analysis around it. */
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

const TETS: readonly (readonly number[])[] = [
  [1, 2, 4, 8],
  [1, 6, 2, 8],
  [1, 4, 3, 8],
  [1, 3, 7, 8],
  [1, 5, 6, 8],
  [1, 7, 5, 8],
];

/** Node n = 1 + i + 2j + 4k at (2i, j, k). */
export const BAR_NODES: FeMeshArtifact['nodes'] = Array.from({ length: 8 }, (_, index) => [
  index + 1,
  (index & 1) * 2,
  (index >> 1) & 1,
  index >> 2,
]);

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae' };

export const hashOf = (artifact: FeMeshArtifact | FeResultsArtifact): string => sha256Hex(canonicalJson(artifact));

export function portOf(...artifacts: (FeMeshArtifact | FeResultsArtifact)[]): FeArtifactPort {
  const byHash = new Map(artifacts.map((artifact) => [hashOf(artifact), artifact]));
  return { get: (hash) => byHash.get(hash) ?? null };
}

/** Faces (element, CalculiX label) whose three nodes all lie in `nodeIds`. */
export function facesOn(nodeIds: readonly number[]): [number, number][] {
  const FACES = [
    [0, 1, 2],
    [0, 3, 1],
    [1, 3, 2],
    [2, 3, 0],
  ] as const;
  const on = new Set(nodeIds);
  const out: [number, number][] = [];
  TETS.forEach((tet, index) =>
    FACES.forEach((face, faceIndex) => {
      if (face.every((corner) => on.has(tet[corner] ?? -1))) out.push([index + 1, faceIndex + 1]);
    }),
  );
  return out;
}

export const X0_NODES = [1, 3, 5, 7];
export const X2_NODES = [2, 4, 6, 8];

export interface BarOptions {
  readonly material?: 'set' | 'models' | 'none' | 'bad_nu';
  readonly analysisType?: 'static' | 'thermo_static' | 'modal' | 'buckling';
  readonly supports?: boolean;
}

export interface Bar {
  readonly doc: CadDocument;
  readonly boxId: string;
  readonly analysisId: string;
  /** Constraint ids by role. */
  readonly constraints: Record<string, string>;
}

const run = (doc: CadDocument, command: string, params: Record<string, unknown>): CadDocument => {
  const result = execute(doc, command, params);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return result.document;
};

/** Steel bar (E 210 GPa, nu 0.3, 0.00785 g/mm^3) in a static analysis; supports: x=0 face held in x, node A (uy, uz), node B (uz). */
export function barDocument(options: BarOptions = {}): Bar {
  const { material = 'set', analysisType = 'static', supports = true } = options;
  let doc = createEmptyDocument();
  const box = execute(doc, 'add_box', { size: [2, 1, 1] });
  const boxId = box.affected[0] ?? '';
  doc = box.document;
  if (material !== 'none') {
    doc = run(doc, 'create_material', { name: 'steel', density: 0.00785, color: '#999999', metalness: 1, roughness: 0.4 });
    if (material === 'set') {
      doc = run(doc, 'add_material_model', {
        material: 'steel',
        id: 'elastic',
        model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
        basis: 'unspecified',
        source: SOURCE,
      });
      doc = run(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true });
    } else if (material !== undefined) {
      const constant = (id: string, property: string, unit: string, value: number): Record<string, unknown> => ({
        id,
        property,
        unit,
        variables: [],
        validity: [],
        form: { kind: 'constant', value },
        basis: 'typical',
        source: SOURCE,
      });
      doc = run(doc, 'define_property_model', { material: 'steel', model: constant('E', 'E', 'GPa', 210) });
      doc = run(doc, 'define_property_model', { material: 'steel', model: constant('nu', 'nu', '1', material === 'bad_nu' ? 0.6 : 0.3) });
    }
    doc = run(doc, 'assign_material', { materialName: 'steel', entityIds: [boxId] });
  }
  const created = execute(doc, 'create_analysis', {
    name: 'bar',
    analysisType,
    ...(analysisType === 'thermo_static' ? { referenceTemperature: { value: 20, unit: 'degC' } } : {}),
  });
  const analysisId = created.affected[0] ?? '';
  doc = run(created.document, 'set_part_idealization', { analysisId, entityId: boxId });
  const constraints: Record<string, string> = {};
  const add = (role: string, kind: string, target: Record<string, unknown>, dofs?: Record<string, number>): void => {
    const result = execute(doc, 'add_fea_constraint', {
      analysisId,
      name: role,
      kind,
      target: { entityId: boxId, ...target },
      ...(dofs ? { dofs } : {}),
    });
    if (result.rejected === true) throw new Error(result.summary);
    doc = result.document;
    constraints[role] = result.affected[0] ?? '';
  };
  if (supports) {
    add('x0', 'displacement', { facesNear: [[0, 0.5, 0.5]] }, { ux: 0 });
    add('nodeA', 'displacement', { pointsNear: [[0, 0, 0]] }, { uy: 0, uz: 0 });
    add('nodeB', 'displacement', { pointsNear: [[0, 1, 0]] }, { uz: 0 });
  }
  return { doc, boxId, analysisId, constraints };
}

/** Mesh artifact of the bar for the CURRENT mesh inputs of the analysis, with the given node / face sets (keys as in the mesh request). */
export function barMesh(
  doc: CadDocument,
  analysisId: string,
  boxId: string,
  nodeSets: Record<string, readonly number[]>,
  faceSets: Record<string, readonly (readonly [number, number])[]> = {},
  type: 'C3D4' = 'C3D4',
): FeMeshArtifact {
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
    nodes: BAR_NODES,
    blocks: [{ type, entityId: boxId, elements: TETS.map((tet, index) => [index + 1, ...tet]) }],
    nodeSets,
    faceSets,
    targets: {},
  };
}

export { run as mustRun };

export interface SolvedBar extends Bar {
  readonly mesh: FeMeshArtifact;
  readonly meshHash: string;
  readonly results: FeResultsArtifact;
  readonly resultsHash: string;
  readonly port: FeArtifactPort;
  readonly probeIds: { readonly ux: string; readonly mises: string };
}

/**
 * The bar pulled by a prescribed end displacement of 0.002 mm (sigma = E * 0.002 / 2 = 210 MPa), with two probes, the mesh artifact and the
 * results artifact parsed from the real CalculiX run in fixtures/static.frd.
 */
export function solvedBar(): SolvedBar {
  const bar = barDocument();
  let doc = bar.doc;
  const pull = execute(doc, 'add_fea_constraint', {
    analysisId: bar.analysisId,
    name: 'pull',
    kind: 'displacement',
    dofs: { ux: 0.002 },
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  doc = pull.document;
  const probes: Record<string, string> = {};
  for (const [role, quantity, point] of [
    ['ux', 'u_x', [2, 0, 0]],
    ['mises', 'von_mises', [1, 0.5, 0.5]],
  ] as const) {
    const added = execute(doc, 'add_result_probe', { analysisId: bar.analysisId, name: role, point, quantity });
    doc = added.document;
    probes[role] = added.affected[0] ?? '';
  }
  const sets: Record<string, number[]> = {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
    [`C_${pull.affected[0]}`]: X2_NODES,
    [`P_${probes['ux']}`]: [2],
    [`P_${probes['mises']}`]: [5],
  };
  const mesh = barMesh(doc, bar.analysisId, bar.boxId, sets);
  const meshHash = hashOf(mesh);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(readFileSync('tests/unit/cae/fixtures/static.frd', 'utf8')),
  };
  return {
    ...bar,
    doc,
    mesh,
    meshHash,
    results,
    resultsHash: hashOf(results),
    port: portOf(mesh, results),
    probeIds: { ux: probes['ux'] ?? '', mises: probes['mises'] ?? '' },
  };
}
