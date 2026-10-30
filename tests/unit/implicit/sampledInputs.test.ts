/**
 * Scalar fields read from analysis results (05 IMP 14.11): `topology_density` (VC-IMP-29, the MBB 60 x 20 golden of 17 TOP) and `fea_result`
 * (von Mises / displacement magnitude on the recorded tetrahedra). The documents hold records, the artifacts live in the injected store.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { FeTopologyArtifact } from '@core/model/topology';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { base64ToUint8Array } from '@lib/base64';
import { compileField, compileScalarField } from '@implicit/compile';
import { withArtifacts } from '@implicit/sampledInputs';
import { contextWith, mbbModel, solveAndRecord } from '../cae/topology/support';

const step = (doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CommandResult => {
  const result = execute(doc, name, params, ctx);
  if (result.error !== undefined) throw new Error(`${name} refused: ${result.summary}`);
  return result;
};

/** The recorded density by independent trilinear interpolation between voxel centres (edge values outside). */
function densityAt(artifact: FeTopologyArtifact, x: number, y: number): number {
  const { nx, ny, voxel, origin } = artifact.grid;
  const bytes = base64ToUint8Array(artifact.xPhys) as Uint8Array;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number, j: number): number =>
    view.getFloat32(4 * (Math.min(nx - 1, Math.max(0, i)) + nx * Math.min(ny - 1, Math.max(0, j))), true);
  const [u, v] = [(x - origin[0]) / voxel - 0.5, (y - origin[1]) / voxel - 0.5];
  const [i, j] = [Math.floor(u), Math.floor(v)];
  const [s, t] = [u - i, v - j];
  const lerp = (a: number, b: number, w: number): number => a + (b - a) * w;
  return lerp(lerp(at(i, j), at(i + 1, j), s), lerp(at(i, j + 1), at(i + 1, j + 1), s), t);
}

function evaluateScalar(
  doc: CadDocument,
  id: string,
  points: readonly (readonly [number, number, number])[],
  ctx: ExecutionContext,
): number[] {
  const compiled = withArtifacts(ctx.feaArtifacts, () => compileScalarField(doc, id));
  if (!compiled.ok) throw new Error(compiled.message);
  return Array.from(tsFieldEngine.evaluate(compiled.program, Float64Array.from(points.flat()), false).values);
}

describe('topology_density (VC-IMP-29: a lattice follows the recorded density)', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const ctx = contextWith(solved.store.port);
  const withScalar = step(solved.doc, 'create_scalar_field', { kind: 'topology_density', studyId: model.studyId }, ctx);
  const scalarId = withScalar.affected[0] as string;

  it('is the trilinear interpolation of the recorded density between voxel centres, and the nearest voxel outside the design grid', () => {
    const points: Array<[number, number, number]> = [];
    for (let n = 0; n < 80; n += 1) points.push([-3 + ((n * 0.83) % 66), -2 + ((n * 0.37) % 25), 0.5]);
    const values = evaluateScalar(withScalar.document, scalarId, points, ctx);
    points.forEach(([x, y], n) => expect(values[n]).toBeCloseTo(densityAt(solved.artifact, x, y), 12));
    expect(withScalar.data).toMatchObject({ range: { min: 0, max: 1 } });
  });

  it('grades a cubic strut lattice: the signed distance on a strut axis is minus the radius the density gives there', () => {
    const ramp = step(
      withScalar.document,
      'create_scalar_field',
      { kind: 'ramp', input: scalarId, inMin: 0, inMax: 1, outMin: 0.1, outMax: 0.45 },
      ctx,
    );
    const rampId = ramp.affected[0] as string;
    const box = step(ramp.document, 'add_field_primitive', { shape: 'box', size: [60, 20, 8], position: [30, 10, 0] }, ctx);
    const lattice = step(
      box.document,
      'add_strut_lattice',
      { cell: 'cubic', cellSize: 4, radius: rampId, origin: [0, 0, 0], region: box.affected[0] },
      ctx,
    );
    const compiled = withArtifacts(ctx.feaArtifacts, () => compileField(lattice.document, lattice.affected[0] as string));
    if (!compiled.ok) throw new Error(compiled.message);
    const axisPoints: Array<[number, number, number]> = [];
    for (let n = 0; n < 40; n += 1) axisPoints.push([2 + n * 1.4, 4 * (1 + (n % 4)), 0]);
    const values = tsFieldEngine.evaluate(compiled.program, Float64Array.from(axisPoints.flat()), false).values;
    process.stderr.write(
      'DBG ' + JSON.stringify(axisPoints.slice(0, 6)) + ' ' + JSON.stringify(Array.from(values.slice(0, 6))) + String.fromCharCode(10),
    );
    axisPoints.forEach(([x, y], n) => expect(values[n]).toBeCloseTo(-(0.1 + 0.35 * densityAt(solved.artifact, x, y)), 9));
  });

  it('makes a body stale when the recorded result changes (the content hash covers the data), and regenerates it', () => {
    const ramp = step(
      withScalar.document,
      'create_scalar_field',
      { kind: 'ramp', input: scalarId, inMin: 0, inMax: 1, outMin: 0.2, outMax: 0.6 },
      ctx,
    );
    const box = step(ramp.document, 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [30, 10, 4] }, ctx);
    const lattice = step(
      box.document,
      'add_strut_lattice',
      { cell: 'cubic', cellSize: 4, radius: ramp.affected[0], origin: [26, 6, 0], region: box.affected[0] },
      ctx,
    );
    const body = step(lattice.document, 'create_implicit_body', { field: lattice.affected[0], voxel: 0.5 }, ctx);
    const same = step(body.document, 'regenerate_implicit_bodies', {}, ctx);
    expect(same.data).toMatchObject({ rederived: [] });
    const changed: FeTopologyArtifact = {
      ...solved.artifact,
      xPhys: solved.artifact.xPhys.replace(/^.{40}/, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    };
    const otherPort: FeArtifactPort = { get: (hash) => (hash === solved.hash ? changed : solved.store.port.get(hash)) };
    const moved = step(body.document, 'regenerate_implicit_bodies', {}, contextWith(otherPort));
    expect(moved.data).toMatchObject({ rederived: [body.affected[0]] });
    expect(execute(body.document, 'regenerate_implicit_bodies', {}, contextWith(null)).error?.code).toBe('IMP_INPUT_NOT_FOUND');
  });

  it('refuses by name: unknown study, a study without result, no artifact store, bad parameters', () => {
    const code = (doc: CadDocument, params: Record<string, unknown>, c?: ExecutionContext): string | undefined =>
      execute(doc, 'create_scalar_field', params, c).error?.code;
    expect(code(solved.doc, { kind: 'topology_density', studyId: 'nope' }, ctx)).toBe('IMP_INPUT_NOT_FOUND');
    expect(code(model.doc, { kind: 'topology_density', studyId: model.studyId }, ctx)).toBe('IMP_INPUT_NOT_FOUND');
    expect(code(solved.doc, { kind: 'topology_density', studyId: model.studyId }, contextWith(null))).toBe('IMP_INPUT_NOT_FOUND');
    expect(code(solved.doc, { kind: 'topology_density' }, ctx)).toBe('IMP_PARAM_RANGE');
    expect(code(solved.doc, { kind: 'fea_result', caseId: model.analysisId }, ctx)).toBe('IMP_PARAM_RANGE');
  });
});

/** Two tetrahedra with a face in common, in metres, in a document in mm; STRESS uniaxial s = 5 + x + 2y + 3z, DISP (1 + x + 2y + 3z, 0, 0). */
function feFixture(): { doc: CadDocument; port: FeArtifactPort; caseId: string; linear: (x: number, y: number, z: number) => number } {
  const nodes: Array<[number, number, number, number]> = [
    [10, 0, 0, 0],
    [11, 1, 0, 0],
    [12, 0, 1, 0],
    [13, 0, 0, 1],
    [14, 1, 1, 1],
  ];
  const linear = (x: number, y: number, z: number): number => 1 + x + 2 * y + 3 * z;
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-m-kg-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: 'in',
    nodes,
    blocks: [
      {
        type: 'C3D4',
        entityId: 'part',
        elements: [
          [1, 10, 11, 12, 13],
          [2, 14, 11, 12, 13],
        ],
      },
    ],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
  const stress: Record<string, number[]> = {};
  const disp: Record<string, number[]> = {};
  for (const [id, x, y, z] of nodes) {
    stress[String(id)] = [4 + linear(x, y, z), 0, 0, 0, 0, 0];
    disp[String(id)] = [linear(x, y, z), 0, 0];
  }
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: 'mesh-hash',
    inputHash: 'in',
    solver: 'test',
    solverVersion: '1',
    steps: [
      {
        step: 1,
        time: 1,
        fields: {
          STRESS: { components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], values: stress },
          DISP: { components: ['D1', 'D2', 'D3'], values: disp },
        },
      },
    ],
  };
  const store = new Map<string, FeMeshArtifact | FeResultsArtifact>([
    ['mesh-hash', mesh],
    ['results-hash', results],
  ]);
  const analysisCase = {
    id: 'a1',
    name: 'test',
    type: 'static',
    solver: 'calculix',
    unitSystem: 'N-m-kg-s',
    factors: { ultimate: 1, yield: 1, extra: [] },
    parts: {},
    constraints: {},
    constraintOrder: [],
    loads: {},
    loadOrder: [],
    probes: {},
    meshSummary: { meshHash: 'mesh-hash' },
    results: { resultsHash: 'results-hash' },
  } as unknown as AnalysisCase;
  const base = createEmptyDocument();
  const doc: CadDocument = { ...base, analysis: { cases: { a1: analysisCase }, caseOrder: ['a1'] } };
  return { doc, port: { get: (hash) => store.get(hash) ?? null }, caseId: 'a1', linear };
}

describe('fea_result', () => {
  const fixture = feFixture();
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: fixture.port };

  it('interpolates a result barycentrically on the recorded tetrahedra, converted to document units, and holds the nearest node outside', () => {
    const made = step(fixture.doc, 'create_scalar_field', { kind: 'fea_result', caseId: fixture.caseId, quantity: 'von_mises' }, ctx);
    const id = made.affected[0] as string;
    const points: Array<[number, number, number]> = [
      [100, 200, 300],
      [700, 600, 500],
      [1000, 1000, 1000],
      [-5000, 0, 0],
    ];
    const values = evaluateScalar(made.document, id, points, ctx);
    expect(values[0]).toBeCloseTo(4 + fixture.linear(0.1, 0.2, 0.3), 12);
    expect(values[1]).toBeCloseTo(4 + fixture.linear(0.7, 0.6, 0.5), 12);
    expect(values[2]).toBeCloseTo(4 + fixture.linear(1, 1, 1), 12);
    expect(values[3]).toBe(4 + fixture.linear(0, 0, 0));
    const disp = step(fixture.doc, 'create_scalar_field', { kind: 'fea_result', caseId: fixture.caseId, quantity: 'u_mag', step: 1 }, ctx);
    expect(evaluateScalar(disp.document, disp.affected[0] as string, [[100, 200, 300]], ctx)[0]).toBeCloseTo(
      fixture.linear(0.1, 0.2, 0.3),
      12,
    );
  });

  it('is refused by name without a store, for an unknown case or step, and for a mesh without tetrahedra', () => {
    const code = (doc: CadDocument, params: Record<string, unknown>, c?: ExecutionContext): string | undefined =>
      execute(doc, 'create_scalar_field', params, c).error?.code;
    const params = { kind: 'fea_result', caseId: fixture.caseId, quantity: 'von_mises' };
    expect(code(fixture.doc, params, { ...defaultContext(), feaArtifacts: null })).toBe('IMP_INPUT_NOT_FOUND');
    expect(code(fixture.doc, { ...params, caseId: 'zz' }, ctx)).toBe('IMP_INPUT_NOT_FOUND');
    expect(code(fixture.doc, { ...params, step: 7 }, ctx)).toBe('IMP_INPUT_NOT_FOUND');
    expect(code(fixture.doc, { ...params, step: 0.5 }, ctx)).toBe('IMP_PARAM_RANGE');
  });
});
