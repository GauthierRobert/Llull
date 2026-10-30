/**
 * The recorded-result inputs outside the commands that make them (05 IMP 14.11): the symmetry of the study and the grid planes, `export_3mf` beam lattices of a density-graded
 * lattice, the save / load round trip of such a body, and the identity of the data in the content hash.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { FieldBuilder } from '@core/geometry/field/build';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { FeArtifactPort } from '@core/model/analysis';
import type { FeTopologyArtifact, SymmetryPlane } from '@core/model/topology';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import { compileScalarField } from '@implicit/compile';
import { implicitPlugin } from '@implicit/plugin';
import { contentHashOf } from '@implicit/realise';
import { installArtifactPort, withArtifacts } from '@implicit/sampledInputs';
import { contextWith, mbbModel, solveAndRecord } from '../cae/topology/support';

const step = (doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): ReturnType<typeof execute> => {
  const result = execute(doc, name, params, ctx);
  if (result.error !== undefined) throw new Error(`${name} refused: ${result.summary}`);
  return result;
};

const floatBytes = (values: readonly number[]): string => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setFloat32(4 * i, value, true));
  return uint8ArrayToBase64(bytes);
};

/** A document holding one topology study with a recorded result whose artifact is `artifact` (the shape the implicit plugin reads; the study record is minimal). */
function studyDoc(
  artifact: FeTopologyArtifact,
  symmetry: readonly SymmetryPlane[],
): { doc: CadDocument; port: FeArtifactPort; ctx: ExecutionContext } {
  const store = new Map<string, FeTopologyArtifact>([['hash-1', artifact]]);
  const study = { id: 'study-1', manufacturing: { symmetry }, result: { fieldHash: 'hash-1', unverified: false } };
  const analysisCase = {
    id: 'a1',
    factors: { ultimate: 1, yield: 1, extra: [] },
    parts: {},
    constraints: {},
    constraintOrder: [],
    loads: {},
    loadOrder: [],
    probes: {},
    topology: { 'study-1': study },
  };
  const doc = { ...createEmptyDocument(), analysis: { cases: { a1: analysisCase }, caseOrder: ['a1'] } } as unknown as CadDocument;
  const port: FeArtifactPort = { get: (hash) => store.get(hash) ?? null };
  return { doc, port, ctx: { ...defaultContext(), feaArtifacts: port } };
}

function density(doc: CadDocument, ctx: ExecutionContext, points: ReadonlyArray<readonly [number, number, number]>): number[] {
  const made = step(doc, 'create_scalar_field', { kind: 'topology_density', studyId: 'study-1' }, ctx);
  const compiled = withArtifacts(ctx.feaArtifacts, () => compileScalarField(made.document, made.affected[0] as string));
  if (!compiled.ok) throw new Error(compiled.message);
  return Array.from(tsFieldEngine.evaluate(compiled.program, Float64Array.from(points.flat()), false).values);
}

const gridArtifact = (values: readonly number[], nx: number, ny: number, plane?: SymmetryPlane): FeTopologyArtifact =>
  ({
    kind: 'fe_topology',
    grid: {
      nx,
      ny,
      nz: 1,
      active: nx * ny,
      keepIn: 0,
      keepOut: 0,
      dimension: 2,
      voxel: 1,
      origin: [0, 0, 0],
      thickness: 1,
      ...(plane === undefined ? {} : { plane }),
    },
    xPhys: floatBytes(values),
  }) as unknown as FeTopologyArtifact;

describe('topology_density follows the study', () => {
  it('mirror-averages across the symmetry planes of the study, like the derived geometry of the topology plugin', () => {
    const values = [0.0, 0.2, 0.4, 0.8, 1.0, 0.6, 0.2, 0.0];
    const artifact = gridArtifact(values, 4, 2);
    const plain = studyDoc(artifact, []);
    const mirrored = studyDoc(artifact, ['YZ']);
    const centres = [0, 1, 2, 3].flatMap((i) => [0, 1].map((j): [number, number, number] => [i + 0.5, j + 0.5, 0.5]));
    const raw = density(plain.doc, plain.ctx, centres);
    const symmetric = density(mirrored.doc, mirrored.ctx, centres);
    centres.forEach((_, n) => expect(raw[n]).toBeCloseTo(values[(n % 2) * 4 + Math.floor(n / 2)] as number, 6));
    // YZ mirrors across the plane normal to x: voxel (i, j) averages with (3 - i, j)
    for (let i = 0; i < 4; i += 1)
      for (let j = 0; j < 2; j += 1) {
        const at = (a: number): number => values[j * 4 + a] as number;
        expect(symmetric[i * 2 + j]).toBeCloseTo(0.5 * (at(i) + at(3 - i)), 6);
      }
    expect(symmetric).not.toEqual(raw);
  });

  it.each([
    ['XY', (i: number, j: number): [number, number, number] => [i + 0.5, j + 0.5, 0.5]],
    ['XZ', (i: number, j: number): [number, number, number] => [i + 0.5, 0.5, j + 0.5]],
    ['YZ', (i: number, j: number): [number, number, number] => [0.5, i + 0.5, j + 0.5]],
  ] as const)('a 2D study on %s lies on its world axes (grid i, j on the in-plane axes, the thickness held)', (plane, world) => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const { doc, ctx } = studyDoc(gridArtifact(values, 3, 2, plane), []);
    const points = [0, 1, 2].flatMap((i) => [0, 1].map((j) => world(i, j)));
    const got = density(doc, ctx, points);
    [0, 1, 2].forEach((i) => [0, 1].forEach((j) => expect(got[i * 2 + j]).toBeCloseTo(values[j * 3 + i] as number, 6)));
    const away = world(1, 1);
    const [x, y, z] = away;
    const shifted: [number, number, number] = plane === 'XY' ? [x, y, 40] : plane === 'XZ' ? [x, -40, z] : [-40, y, z];
    expect(density(doc, ctx, [shifted])[0]).toBeCloseTo(values[1 * 3 + 1] as number, 6);
  });
});

describe('a density-graded lattice outside the commands that built it (VC-IMP-29 print path, load)', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const ctx = contextWith(solved.store.port);
  afterEach(() => installArtifactPort(null));

  function gradedBody(): { doc: CadDocument; bodyId: string } {
    const scalar = step(solved.doc, 'create_scalar_field', { kind: 'topology_density', studyId: model.studyId }, ctx);
    const ramp = step(
      scalar.document,
      'create_scalar_field',
      { kind: 'ramp', input: scalar.affected[0], inMin: 0, inMax: 1, outMin: 0.2, outMax: 0.6 },
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
    return { doc: body.document, bodyId: body.affected[0] as string };
  }

  it('is written as a beam lattice by export_3mf with the artifact store of its context', () => {
    const { doc, bodyId } = gradedBody();
    const written = step(doc, 'export_3mf', { entityIds: [bodyId], beamLattice: true }, ctx);
    expect(written.data).toMatchObject({ beamLattice: { written: [bodyId], skipped: [] } });
  });

  it('is written as a level set by export_3mf when a gyroid sheet is graded by the density', () => {
    const scalar = step(solved.doc, 'create_scalar_field', { kind: 'topology_density', studyId: model.studyId }, ctx);
    const ramp = step(
      scalar.document,
      'create_scalar_field',
      { kind: 'ramp', input: scalar.affected[0], inMin: 0, inMax: 1, outMin: 0.3, outMax: 0.9 },
      ctx,
    );
    const gyroid = step(
      ramp.document,
      'add_tpms_lattice',
      { kind: 'gyroid', form: 'sheet', thickness: ramp.affected[0], cellSize: 5, origin: [0, 0, 0] },
      ctx,
    );
    const box = step(gyroid.document, 'add_field_primitive', { shape: 'box', size: [10, 10, 5], position: [30, 10, 2.5] }, ctx);
    const cut = step(box.document, 'combine_fields', { op: 'intersect', a: gyroid.affected[0], b: box.affected[0] }, ctx);
    const body = step(cut.document, 'create_implicit_body', { field: cut.affected[0], voxel: 0.4 }, ctx);
    const written = step(body.document, 'export_3mf', { entityIds: [body.affected[0]], implicit: 'levelset' }, ctx);
    expect(written.data).toMatchObject({ implicit: { written: [body.affected[0]], skipped: [] } });
    const without = step(body.document, 'export_3mf', { entityIds: [body.affected[0]], implicit: 'levelset' }, contextWith(null));
    expect((without.data as { implicit: { skipped: Array<{ reason: string }> } }).implicit.skipped[0]?.reason).toContain(
      'artifact store holds no density field',
    );
  });

  it('is re-derived on load from the artifact store the host installed, with its record intact', () => {
    const { doc, bodyId } = gradedBody();
    const saved = serializeDocument(doc);
    installArtifactPort(solved.store.port);
    const loaded = deserializeDocument(saved);
    expect(loaded.entities[bodyId]?.kind).toBe('mesh');
    expect(loaded.implicit?.bodies[bodyId]?.contentHash).toBe(doc.implicit?.bodies[bodyId]?.contentHash);
    expect(implicitPlugin.document?.afterLoad?.(loaded)).toEqual([]);
  });

  it('stays unrealised without the store and says so by name, then is realised in place by regenerate_implicit_bodies', () => {
    const { doc, bodyId } = gradedBody();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.entities[bodyId]).toBeUndefined();
    const reported = implicitPlugin.document?.afterLoad?.(loaded) ?? [];
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('IMP_INPUT_NOT_FOUND');
    expect(reported[0]).not.toContain('could not be realised on this machine');
    const regenerated = step(loaded, 'regenerate_implicit_bodies', {}, ctx);
    expect(regenerated.data).toMatchObject({ rederived: [bodyId] });
  });
});

describe('the content hash takes the identity of sampled data, not its numbers', () => {
  const meta = { bounds: null, lipschitz: 1, quality: 'approximate' } as const;
  const programOf = (values: number[], source?: string): ReturnType<FieldBuilder['finish']> => {
    const b = new FieldBuilder('mm');
    const field = {
      kind: 'grid',
      nodes: [2, 1, 1],
      origin: [0, 0, 0],
      voxel: 1,
      values,
      ...(source === undefined ? {} : { source }),
    } as const;
    return b.finish(b.sampledField(field, b.x(), b.y(), b.z()), meta);
  };
  const grid = { min: [0, 0, 0], max: [1, 1, 1], voxel: 0.5 } as const;

  it('equal sources hash equal whatever the numbers, other sources differ, and data without a source hashes its numbers', () => {
    const hash = (values: number[], source?: string): string => contentHashOf(programOf(values, source), grid, {});
    expect(hash([0, 1], 'r1')).toBe(hash([5, 6], 'r1'));
    expect(hash([0, 1], 'r1')).not.toBe(hash([0, 1], 'r2'));
    expect(hash([0, 1])).not.toBe(hash([5, 6]));
  });
});
