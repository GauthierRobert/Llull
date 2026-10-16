/** PHY-03 fixtures: thermal analyses around a box, hand-built tet meshes (2 tets, structured bar) and hand-built results artifacts. */
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/thermal' };

export const hashOf = (artifact: FeMeshArtifact | FeResultsArtifact): string => sha256Hex(canonicalJson(artifact));

export function portOf(...artifacts: (FeMeshArtifact | FeResultsArtifact)[]): FeArtifactPort {
  const byHash = new Map(artifacts.map((artifact) => [hashOf(artifact), artifact]));
  return { get: (hash) => byHash.get(hash) ?? null };
}

/** Run a command and fail the test setup when it is refused. */
export function must(doc: CadDocument, command: string, params: Record<string, unknown>): CommandResult {
  const result = execute(doc, command, params);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return result;
}

export const caseOf = (doc: CadDocument, analysisId: string): AnalysisCase => {
  const found = doc.analysis?.cases[analysisId];
  if (found === undefined) throw new Error(`no analysis ${analysisId}`);
  return found;
};

export interface MaterialSpec {
  /** Conductivity W/(m K): a constant, or a table of [T degC, k]. */
  readonly k?: number | readonly (readonly [number, number])[] | null;
  readonly cp?: number | null;
  readonly density?: number | null;
  readonly basis?: 'company' | 'typical';
  readonly name?: string;
}

const constantModel = (id: string, property: string, unit: string, value: number, basis: string): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis,
  source: SOURCE,
});

/** Document with a material carrying thermal property models (kg/m3 documents the density model; k, cp constants or a k(T) table). */
export function withMaterial(doc: CadDocument, spec: MaterialSpec = {}): CadDocument {
  const { k = 15, cp = 500, density = 8000, basis = 'company', name = 'steel' } = spec;
  let next = must(doc, 'create_material', { name, density: 0.008, color: '#999999', metalness: 1, roughness: 0.4 }).document;
  const model = (params: Record<string, unknown>): void => {
    next = must(next, 'define_property_model', { material: name, model: params }).document;
  };
  if (Array.isArray(k))
    model({
      id: 'k_table',
      property: 'k',
      unit: 'W/(m*K)',
      variables: [{ variable: 'T', unit: 'degC' }],
      validity: [{ variable: 'T', unit: 'degC', data: [k[0]?.[0] ?? 0, k[k.length - 1]?.[0] ?? 0] }],
      form: { kind: 'table1d', variable: 'T', points: k, interpolation: 'linear' },
      basis,
      source: SOURCE,
    });
  else if (typeof k === 'number') model(constantModel('k_const', 'k', 'W/(m*K)', k, basis));
  if (cp !== null) model(constantModel('cp_const', 'cp', 'J/(kg*K)', cp, basis));
  if (density !== null) model(constantModel('rho_const', 'density', 'kg/m^3', density, basis));
  return must(next, 'assign_material', { materialName: name, entityIds: [Object.keys(next.entities)[0] ?? ''] }).document;
}

export interface ThermalFixture {
  readonly doc: CadDocument;
  readonly boxId: string;
  readonly analysisId: string;
}

export interface FixtureOptions extends MaterialSpec {
  readonly type?: 'heat_steady' | 'heat_transient';
  readonly units?: 'mm' | 'm';
  readonly size?: readonly [number, number, number];
  readonly scale?: 'degC' | 'K';
  readonly noMaterial?: boolean;
}

/** A box (default 1 m x 1 m x 0.05 m, metre document) with a material and an empty heat analysis that has the box as its part. */
export function thermalFixture(options: FixtureOptions = {}): ThermalFixture {
  const { type = 'heat_steady', units = 'm', size = [1, 1, 0.05], scale = 'degC' } = options;
  let doc = must(createEmptyDocument(), 'set_units', { units }).document;
  const box = must(doc, 'add_box', { size: [...size], anchor: 'min' });
  const boxId = box.affected[0] ?? '';
  doc = options.noMaterial === true ? box.document : withMaterial(box.document, options);
  const created = must(doc, 'create_analysis', { name: 'thermal', analysisType: type, temperatureScale: scale });
  const analysisId = created.affected[0] ?? '';
  doc = must(created.document, 'set_part_idealization', { analysisId, entityId: boxId }).document;
  return { doc, boxId, analysisId };
}

/** Add a thermal BC; returns the new document and the BC id. */
export function addBc(fixture: ThermalFixture, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = must(fixture.doc, 'add_thermal_bc', { analysisId: fixture.analysisId, ...params });
  return { doc: result.document, id: result.affected[0] ?? '' };
}

type FaceSet = readonly (readonly [number, number])[];
const FACE_CORNERS = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
] as const;

/** CalculiX faces (element, label) of `tets` whose three corner nodes all lie in `nodeIds`. */
export function facesOn(tets: readonly (readonly number[])[], nodeIds: readonly number[]): [number, number][] {
  const on = new Set(nodeIds);
  const out: [number, number][] = [];
  tets.forEach((tet, index) =>
    FACE_CORNERS.forEach((corners, faceIndex) => {
      if (corners.every((corner) => on.has(tet[corner] ?? -1))) out.push([index + 1, faceIndex + 1]);
    }),
  );
  return out;
}

export interface MeshSets {
  readonly nodeSets?: Record<string, readonly number[]>;
  readonly faceSets?: Record<string, FaceSet>;
}

/** Two tets sharing a face: A = nodes 1-2-3-4 (V = 1/6), B = nodes 2-3-4-5 (V = 1/3). Total volume 1/2 (length unit cubed). */
const TWO_TET_NODES: FeMeshArtifact['nodes'] = [
  [1, 0, 0, 0],
  [2, 1, 0, 0],
  [3, 0, 1, 0],
  [4, 0, 0, 1],
  [5, 1, 1, 1],
];
export const TWO_TETS: readonly (readonly number[])[] = [
  [1, 2, 3, 4],
  [2, 3, 4, 5],
];

export function twoTetMesh(fixture: ThermalFixture, sets: MeshSets = {}, type: 'C3D4' = 'C3D4'): FeMeshArtifact {
  const analysisCase = caseOf(fixture.doc, fixture.analysisId);
  return {
    kind: 'fe_mesh',
    unitSystem: analysisCase.unitSystem,
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(fixture.doc, fixture.analysisId, 'mesh'),
    nodes: TWO_TET_NODES,
    blocks: [{ type, entityId: fixture.boxId, elements: TWO_TETS.map((tet, index) => [index + 1, ...tet]) }],
    nodeSets: { ...sets.nodeSets },
    faceSets: { ...sets.faceSets },
    targets: {},
  };
}

export interface BarMesh {
  readonly nodes: FeMeshArtifact['nodes'];
  readonly tets: readonly (readonly number[])[];
  /** Node ids on the x = 0 and x = length end faces. */
  readonly leftNodes: readonly number[];
  readonly rightNodes: readonly number[];
  readonly nodeAt: (i: number, j: number, k: number) => number;
}

/** Structured nx x 1 x 1 bar of cubes (Kuhn split into 6 positive tets each, conforming): lengths dx, dy, dz per cell. */
export function barTets(nx: number, dx: number, dy: number, dz: number): BarMesh {
  const nodeAt = (i: number, j: number, k: number): number => 1 + i + (nx + 1) * (j + 2 * k);
  const nodes: [number, number, number, number][] = [];
  for (let k = 0; k < 2; k += 1)
    for (let j = 0; j < 2; j += 1) for (let i = 0; i <= nx; i += 1) nodes.push([nodeAt(i, j, k), i * dx, j * dy, k * dz]);
  const position = new Map(nodes.map(([id, x, y, z]) => [id, [x, y, z] as const]));
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const;
  const tets: number[][] = [];
  for (let i = 0; i < nx; i += 1)
    for (const order of orders) {
      const at = [0, 0, 0];
      const ids = [nodeAt(i, 0, 0)];
      for (const axis of order) {
        at[axis] = 1;
        ids.push(nodeAt(i + (at[0] ?? 0), at[1] ?? 0, at[2] ?? 0));
      }
      const [a, b, c, d] = ids.map((id) => position.get(id) ?? [0, 0, 0]);
      const u = [(b?.[0] ?? 0) - (a?.[0] ?? 0), (b?.[1] ?? 0) - (a?.[1] ?? 0), (b?.[2] ?? 0) - (a?.[2] ?? 0)];
      const v = [(c?.[0] ?? 0) - (a?.[0] ?? 0), (c?.[1] ?? 0) - (a?.[1] ?? 0), (c?.[2] ?? 0) - (a?.[2] ?? 0)];
      const w = [(d?.[0] ?? 0) - (a?.[0] ?? 0), (d?.[1] ?? 0) - (a?.[1] ?? 0), (d?.[2] ?? 0) - (a?.[2] ?? 0)];
      const det =
        (u[0] ?? 0) * ((v[1] ?? 0) * (w[2] ?? 0) - (v[2] ?? 0) * (w[1] ?? 0)) -
        (u[1] ?? 0) * ((v[0] ?? 0) * (w[2] ?? 0) - (v[2] ?? 0) * (w[0] ?? 0)) +
        (u[2] ?? 0) * ((v[0] ?? 0) * (w[1] ?? 0) - (v[1] ?? 0) * (w[0] ?? 0));
      tets.push(det > 0 ? ids : [ids[0] ?? 0, ids[2] ?? 0, ids[1] ?? 0, ids[3] ?? 0]);
    }
  const ends = (i: number): number[] => [nodeAt(i, 0, 0), nodeAt(i, 1, 0), nodeAt(i, 0, 1), nodeAt(i, 1, 1)];
  return { nodes, tets, leftNodes: ends(0), rightNodes: ends(nx), nodeAt };
}

/** Mesh artifact for a fixture over structured bar tets. */
export function barMesh(fixture: ThermalFixture, bar: BarMesh, sets: MeshSets): FeMeshArtifact {
  return {
    kind: 'fe_mesh',
    unitSystem: caseOf(fixture.doc, fixture.analysisId).unitSystem,
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(fixture.doc, fixture.analysisId, 'mesh'),
    nodes: bar.nodes,
    blocks: [{ type: 'C3D4', entityId: fixture.boxId, elements: bar.tets.map((tet, index) => [index + 1, ...tet]) }],
    nodeSets: { ...sets.nodeSets },
    faceSets: { ...sets.faceSets },
    targets: {},
  };
}

type Field = Record<string, readonly number[]>;
const nodalField = (components: readonly string[], values: Field): { components: readonly string[]; values: Field } => ({
  components,
  values,
});

/** Results artifact with one NDTEMP (and optionally RFL / FLUX) field per step: `temperatures[n]` by node id. */
export function resultsFor(
  fixture: ThermalFixture,
  mesh: FeMeshArtifact,
  steps: readonly {
    readonly time: number;
    readonly temperature: Record<number, number>;
    readonly reaction?: Record<number, number>;
    readonly flux?: Record<number, readonly number[]>;
  }[],
): FeResultsArtifact {
  return {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(fixture.doc, fixture.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: steps.map((step, index) => ({
      step: index + 1,
      time: step.time,
      fields: {
        NDTEMP: nodalField(['T'], Object.fromEntries(Object.entries(step.temperature).map(([node, t]) => [node, [t]]))),
        ...(step.reaction !== undefined
          ? { RFL: nodalField(['RFL'], Object.fromEntries(Object.entries(step.reaction).map(([node, r]) => [node, [r]]))) }
          : {}),
        ...(step.flux !== undefined ? { FLUX: nodalField(['F1', 'F2', 'F3'], step.flux) } : {}),
      },
    })),
  };
}

/** Record a mesh and results into the document the way record_fe_mesh / record_fea_results do (summaries computed by the pure summarisers). */
export function recorded(
  fixture: ThermalFixture,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  summarise: (doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, results: FeResultsArtifact) => unknown,
): CadDocument {
  const analysisCase = caseOf(fixture.doc, fixture.analysisId);
  const resultsSummary = {
    resultsHash: hashOf(results),
    inputHash: results.inputHash,
    solver: results.solver,
    solverVersion: results.solverVersion,
    loadCases: [],
    units: mesh.unitSystem,
    thermal: summarise(fixture.doc, fixture.analysisId, mesh, results),
  };
  const meshSummary = {
    meshHash: hashOf(mesh),
    inputHash: mesh.inputHash,
    mesher: mesh.mesher,
    mesherVersion: mesh.mesherVersion,
    nodes: mesh.nodes.length,
    elements: {},
    quality: { metrics: {}, inverted: 0 },
    warnings: [],
    faceMap: [],
  };
  const next = { ...analysisCase, meshSummary, results: resultsSummary } as AnalysisCase;
  return {
    ...fixture.doc,
    analysis: { cases: { ...fixture.doc.analysis?.cases, [fixture.analysisId]: next }, caseOrder: fixture.doc.analysis?.caseOrder ?? [] },
  };
}
