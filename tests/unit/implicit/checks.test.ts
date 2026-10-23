/** check_implicit and implicit_properties on bodies (05 IMP M3; VC-IMP-33..36, 42, 43, 47). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { CadDocument } from '@core/model/types';
import { type Step, empty, expectRefused, ok, run } from './helpers';

interface Finding {
  code: string;
  severity: string;
  value: number | null;
  limit: number | null;
  location: number[] | null;
}
interface Check {
  status: string;
  findings: Finding[];
  limits: Array<{ name: string; value: number; source: string; defaulted: boolean }>;
  reviewRequired: boolean;
  reviewReason: string | null;
  features: { smallestWall: number | null; smallestStrutDiameter: number | null };
}

const check = (doc: CadDocument, id: string, extra: Record<string, unknown> = {}): Step => ok(doc, 'check_implicit', { id, ...extra });
const codes = (data: unknown): string[] => (data as Check).findings.map((f) => f.code);

const sphereBody = (radius: number, voxel: number, extra: Record<string, unknown> = {}): { sphere: Step; body: Step } => {
  const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius });
  return { sphere, body: ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel, ...extra }) };
};

describe('implicit_properties on bodies', () => {
  it('reports volume, area, density, components and the error statement for a sphere', () => {
    const { body } = sphereBody(10, 0.4);
    const props = ok(body.doc, 'implicit_properties', { id: body.id });
    const exactVolume = (4 / 3) * Math.PI * 1000;
    expect(Math.abs((props.data['volume'] as number) - exactVolume) / exactVolume).toBeLessThan(0.002);
    expect(Math.abs((props.data['area'] as number) - 4 * Math.PI * 100) / (4 * Math.PI * 100)).toBeLessThan(0.002);
    expect(props.data['components']).toBe(1);
    expect(props.data['enclosedVoids']).toEqual([]);
    expect(props.data['unit']).toBe('mm');
    expect(props.data['volumeUnit']).toBe('mm^3');
    expect(props.data['densityReference']).toBe('support box');
    expect((props.data['relativeDensity'] as number) / (Math.PI / 6)).toBeCloseTo(1, 2);
    expect(props.data['errorEstimate']).toMatchObject({ kind: 'estimated' });
    expect(props.data['provenance']).toMatchObject({ engine: 'ts', deterministic: true, quadrature: 'midpoint' });
    expect(props.result.summary).toContain('implicit_properties');
    expect(execute(body.doc, 'implicit_properties', { id: body.id }).document).toBe(body.doc);
  });

  it('refuses unknown ids, a bad voxel, an unbounded field and an over-budget measure', () => {
    const { body, sphere } = sphereBody(3, 0.5);
    expectRefused(body.doc, run(body.doc, 'implicit_properties', { id: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(body.doc, run(body.doc, 'implicit_properties', { id: body.id, region: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(body.doc, run(body.doc, 'implicit_properties', { id: body.id, voxel: -1 }), 'IMP_PARAM_RANGE');
    expectRefused(body.doc, run(body.doc, 'implicit_properties', { id: body.id, voxel: 0.001 }), 'IMP_GRID_BUDGET');
    const plane = ok(body.doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0.013 });
    expectRefused(plane.doc, run(plane.doc, 'implicit_properties', { id: plane.id }), 'IMP_FIELD_UNBOUNDED');
    const half = ok(plane.doc, 'implicit_properties', { id: plane.id, region: sphere.id });
    expect(Math.abs((half.data['volume'] as number) - (2 / 3) * Math.PI * 27) / ((2 / 3) * Math.PI * 27)).toBeLessThan(0.02);
    expect(half.data['densityReference']).toBe(`region ${sphere.id}`);
  });
});

describe('check_implicit findings', () => {
  it('a solid sphere with declared limits echoes them and reports what it could not evaluate (VC-IMP-36)', () => {
    const { body } = sphereBody(5, 0.5);
    const verdict = check(body.doc, body.id, { process: { minWallMm: 0.4, minStrutMm: 0.5, minPoreMm: 1, source: 'owner-supplied' } });
    const data = verdict.data as unknown as Check;
    expect(data.status).toBe('warn');
    expect(data.findings.map((f) => f.code)).toEqual(['IMP_CHECK_NOT_EVALUATED']);
    expect(data.limits).toEqual([
      { name: 'minWallMm', value: 0.4, unit: 'mm', source: 'owner-supplied', defaulted: false },
      { name: 'minPoreMm', value: 1, unit: 'mm', source: 'owner-supplied', defaulted: false },
      { name: 'minStrutMm', value: 0.5, unit: 'mm', source: 'owner-supplied', defaulted: false },
    ]);
    expect(verdict.data['notEvaluated']).toEqual(['minPoreMm', 'minWallMm', 'minStrutMm']);
    expect(verdict.result.summary).toContain('WARN');
    expect(data.reviewRequired).toBe(false);
  });

  it('without process limits IMP_CHECK_NO_PROCESS_LIMITS is always reported (never defaulted)', () => {
    const { body } = sphereBody(5, 0.5);
    const verdict = check(body.doc, body.id);
    expect(codes(verdict.data)).toEqual(['IMP_CHECK_NO_PROCESS_LIMITS']);
    expect((verdict.data as unknown as Check).status).toBe('warn');
    expect((verdict.data as unknown as Check).limits).toEqual([]);
  });

  it('a sphere shelled inside by 2 traps a void of 4/3 pi 8^3 (VC-IMP-33)', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const shell = ok(sphere.doc, 'shell_field', { field: sphere.id, thickness: 2 });
    const body = ok(shell.doc, 'create_implicit_body', { field: shell.id, voxel: 0.25 });
    const verdict = check(body.doc, body.id, { process: { minWallMm: 1, source: 'owner-supplied' } });
    const data = verdict.data as unknown as Check;
    expect(data.status).toBe('fail');
    const trapped = data.findings.filter((f) => f.code === 'IMP_TRAPPED_VOID');
    expect(trapped).toHaveLength(1);
    const exact = (4 / 3) * Math.PI * 512;
    expect(Math.abs((trapped[0]?.value ?? 0) - exact) / exact).toBeLessThan(0.01);
    const point = trapped[0]?.location ?? [99, 99, 99];
    expect(Math.hypot(...point)).toBeLessThan(8);
    expect(data.features.smallestWall).toBe(2);
    const props = ok(body.doc, 'implicit_properties', { id: body.id });
    expect((props.data['enclosedVoids'] as unknown[]).length).toBe(1);
  });

  it('two disjoint spheres are IMP_DISCONNECTED with their component count (VC-IMP-34)', () => {
    const left = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3, position: [-5, 0, 0] });
    const right = ok(left.doc, 'add_field_primitive', { shape: 'sphere', radius: 3, position: [5, 0, 0] });
    const both = ok(right.doc, 'combine_fields', { op: 'union', a: left.id, b: right.id });
    const body = ok(both.doc, 'create_implicit_body', { field: both.id, voxel: 0.4 });
    const data = check(body.doc, body.id).data as unknown as Check;
    const finding = data.findings.find((f) => f.code === 'IMP_DISCONNECTED');
    expect(finding?.value).toBe(2);
    expect(data.status).toBe('fail');
    const props = ok(body.doc, 'implicit_properties', { id: body.id });
    expect(props.data['components']).toBe(2);
  });

  it('a wall thinner than 2 voxels warns IMP_CHECK_RESOLUTION_COARSE (VC-IMP-35) and one below the process limit fails IMP_CHECK_MIN_WALL', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const shell = ok(sphere.doc, 'shell_field', { field: sphere.id, thickness: 0.3 });
    const body = ok(shell.doc, 'create_implicit_body', { field: shell.id, voxel: 0.2 });
    const coarse = check(body.doc, body.id, { process: { minWallMm: 0.5, source: 'owner-supplied' } }).data as unknown as Check;
    expect(codes(coarse)).toEqual(expect.arrayContaining(['IMP_CHECK_RESOLUTION_COARSE', 'IMP_CHECK_MIN_WALL']));
    const minWall = coarse.findings.find((f) => f.code === 'IMP_CHECK_MIN_WALL');
    expect(minWall).toMatchObject({ severity: 'fail', limit: 0.5 });
    expect(minWall?.value).toBeCloseTo(0.3, 9);
    expect(coarse.findings.find((f) => f.code === 'IMP_CHECK_RESOLUTION_COARSE')).toMatchObject({ severity: 'warn', limit: 0.4 });
  });

  it('a strut lattice below the strut limit fails IMP_CHECK_MIN_STRUT; units convert to millimetres', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    const lattice = ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 0.4, region: box.id });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.2 });
    const data = check(body.doc, body.id, { process: { minStrutMm: 1, source: 'owner-supplied' } }).data as unknown as Check;
    expect(data.findings.find((f) => f.code === 'IMP_CHECK_MIN_STRUT')?.value).toBeCloseTo(0.8, 9);
    expect(data.features.smallestStrutDiameter).toBeCloseTo(0.8, 9);
    const inches: CadDocument = { ...body.doc, units: 'in' };
    const converted = check(inches, body.id, { process: { minStrutMm: 25, source: 'owner-supplied' } }).data as unknown as Check;
    expect(converted.findings.find((f) => f.code === 'IMP_CHECK_MIN_STRUT')?.value).toBeCloseTo(0.8 * 25.4, 6);
  });

  it('release purpose is reviewRequired with the review statement (AF-33); unpinned inputs add a warning (VC-IMP-43)', () => {
    const tetra = { positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] };
    const mesh = ok(empty(), 'import_mesh', { bodies: [tetra] });
    const entity = mesh.doc.entities[mesh.id];
    if (entity?.kind !== 'mesh') throw new Error('mesh expected');
    const unpinned: CadDocument = {
      ...mesh.doc,
      entities: { ...mesh.doc.entities, [mesh.id]: { ...entity, meshSource: { format: 'stl-binary', unitScale: 1, verified: false } } },
    };
    const field = ok(unpinned, 'field_from_solid', { entityId: mesh.id });
    const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5 });
    const verdict = check(body.doc, body.id, { purpose: 'release', process: { minWallMm: 0.1, source: 'owner-supplied' } });
    const data = verdict.data as unknown as Check;
    expect(codes(data)).toContain('IMP_CHECK_INPUT_UNVERIFIED');
    expect(data.reviewRequired).toBe(true);
    expect(data.reviewReason).toContain('qualified engineer');
    expect(verdict.result.summary).toContain('not approved: needs a qualified engineer');
    expect(verdict.data['unverified']).toBe(true);
    expect(ok(body.doc, 'implicit_properties', { id: body.id }).data['unverified']).toBe(true);
  });

  it('flags a mesh that is not closed and edge-manifold; reports components as unavailable when the engine refuses', () => {
    const { body } = sphereBody(3, 0.5);
    const entity = body.doc.entities[body.id];
    if (entity?.kind !== 'mesh') throw new Error('mesh expected');
    const damaged: CadDocument = {
      ...body.doc,
      entities: {
        ...body.doc.entities,
        [body.id]: { ...entity, mesh: { positions: entity.mesh.positions, indices: entity.mesh.indices.slice(3) } },
      },
    };
    expect(codes(check(damaged, body.id).data)).toContain('IMP_CHECK_MESH_NOT_MANIFOLD');
    const refusing = { ...tsFieldEngine, measure: () => ({ ok: false as const, code: 'IMP_GRID_BUDGET' as const, message: 'too big' }) };
    const ctx = {
      kernel: null,
      ids: { next: (p: string) => `${p}-x` },
      registry: () => undefined,
      projectDepth: 0,
      recipeDepth: 0,
      replayCache: null,
      fieldEngine: refusing,
    };
    const answer = execute(body.doc, 'check_implicit', { id: body.id }, ctx);
    expect((answer.data as { componentNote: string }).componentNote).toContain('too big');
    const props = execute(body.doc, 'implicit_properties', { id: body.id }, ctx);
    expect(props.error?.code).toBe('IMP_GRID_BUDGET');
  });

  it('refuses a missing body and is pure', () => {
    const { body } = sphereBody(3, 0.5);
    expectRefused(body.doc, run(body.doc, 'check_implicit', { id: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    const before = JSON.stringify(body.doc);
    check(body.doc, body.id);
    expect(JSON.stringify(body.doc)).toBe(before);
  });
});
