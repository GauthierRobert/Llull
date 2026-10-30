/** create_implicit_body, derivation guard, persistence (D3), engine port, budgets (05 IMP M2; VC-IMP-20, 46, 48). */
import { describe, expect, it } from 'vitest';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { setFieldEngine } from '@core/geometry/field/engine';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { derivedEntityIds } from '@core/plugins/host';
import { type Step, empty, expectRefused, ok, run } from './helpers';

const sphereBody = (radius = 5, voxel = 0.5): { field: Step; body: Step } => {
  const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius });
  const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel });
  return { field, body };
};

describe('create_implicit_body', () => {
  it('realises a closed, oriented, read-only mesh whose volume follows the second-order error law (VC-IMP-20)', () => {
    const { field, body } = sphereBody(5, 0.5);
    expect(body.result.affected).toEqual([body.id]);
    expect(body.doc.order).toContain(body.id);
    const entity = body.doc.entities[body.id];
    expect(entity?.kind).toBe('mesh');
    expect(entity?.layerId).toBe('layer-implicit');
    expect(body.doc.layers['layer-implicit']?.visible).toBe(true);
    expect(body.data['closedManifold']).toBe(true);
    const exact = (4 / 3) * Math.PI * 125;
    const volume = body.data['volumeMesh'] as number;
    expect(Math.abs(volume - exact) / exact).toBeLessThanOrEqual(0.6 * (0.5 / 5) ** 2);
    const estimate = body.data['errorEstimate'] as { value: number; kind: string };
    expect(estimate.kind).toBe('estimated');
    expect(estimate.value).toBeGreaterThan(Math.abs(volume - exact));
    expect(body.data['provenance']).toMatchObject({ engine: 'ts', deterministic: true, voxel: 0.5 });
    expect(body.doc.implicit?.bodies[body.id]).toMatchObject({ field: field.id, voxel: 0.5, mesher: 'tetra' });
    expect(derivedEntityIds(body.doc)).toEqual(new Set([body.id]));
    expect(body.result.summary).toContain('implicit_properties');
  });

  it('is deterministic: the same field and voxel give the same content hash and mesh', () => {
    const { field, body } = sphereBody();
    const again = ok(body.doc, 'create_implicit_body', { field: field.id, voxel: 0.5 });
    expect(again.data['contentHash']).toBe(body.data['contentHash']);
    expect(JSON.stringify(again.doc.entities[again.id])).toBe(JSON.stringify({ ...body.doc.entities[body.id], id: again.id }));
    const finer = ok(body.doc, 'create_implicit_body', { field: field.id, voxel: 0.4 });
    expect(finer.data['contentHash']).not.toBe(body.data['contentHash']);
  });

  it('hides the listed sources on a hidden layer and honours name, colour, bounds and maxTriangles', () => {
    const box = ok(empty(), 'add_box', { size: [4, 4, 4] });
    const field = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const body = ok(field.doc, 'create_implicit_body', {
      field: field.id,
      voxel: 0.5,
      hideSource: [box.id],
      name: 'cube body',
      color: '#112233',
      bounds: { min: [-2.1, -2.1, -2.1], max: [2.1, 2.1, 2.1] },
    });
    expect(body.doc.entities[box.id]?.layerId).toBe('layer-implicit-hidden');
    expect(body.doc.layers['layer-implicit-hidden']?.visible).toBe(false);
    expect(body.doc.entities[body.id]).toMatchObject({ name: 'cube body', color: '#112233' });
    expect(body.data['hiddenSources']).toEqual([box.id]);
    expect(Math.abs((body.data['volumeMesh'] as number) - 64) / 64).toBeLessThan(0.05);
    expectRefused(
      field.doc,
      run(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, hideSource: ['nope'] }),
      'IMP_ENTITY_NOT_FOUND',
    );
    expectRefused(
      field.doc,
      run(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, maxTriangles: 10 }),
      'IMP_TRIANGLE_BUDGET',
    );
  });

  it('refuses bad input with stable codes and leaves the document unchanged', () => {
    const { field } = sphereBody();
    const doc = field.doc;
    expectRefused(doc, run(doc, 'create_implicit_body', { field: 'nope', voxel: 1 }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(doc, run(doc, 'create_implicit_body', { field: field.id, voxel: 0 }), 'IMP_PARAM_RANGE');
    const plane = ok(doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    expectRefused(plane.doc, run(plane.doc, 'create_implicit_body', { field: plane.id, voxel: 1 }), 'IMP_FIELD_UNBOUNDED');
    const small = ok(plane.doc, 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const big = ok(small.doc, 'add_field_primitive', { shape: 'sphere', radius: 6 });
    const nothing = ok(big.doc, 'combine_fields', { op: 'subtract', a: small.id, b: big.id });
    expectRefused(nothing.doc, run(nothing.doc, 'create_implicit_body', { field: nothing.id, voxel: 0.5 }), 'IMP_BODY_EMPTY');
    const before = JSON.stringify(doc);
    ok(doc, 'create_implicit_body', { field: field.id, voxel: 1 });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('refuses a huge grid before sampling, in well under 100 ms (VC-IMP-46)', () => {
    const big = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 1000 });
    const started = Date.now();
    const refused = run(big.doc, 'create_implicit_body', { field: big.id, voxel: 0.001 });
    expect(Date.now() - started).toBeLessThan(100);
    expectRefused(big.doc, refused, 'IMP_GRID_BUDGET');
    expect(refused.result.error?.remediation).toContain('native');
  });

  it('uses the field engine given on the context (the port)', () => {
    const { field } = sphereBody();
    const calls: string[] = [];
    const counting: FieldEngine = {
      ...tsFieldEngine,
      name: 'counting',
      mesh: (...args) => {
        calls.push('mesh');
        return tsFieldEngine.mesh(...args);
      },
      measure: (...args) => {
        calls.push('measure');
        return tsFieldEngine.measure(...args);
      },
      evaluate: (...args) => {
        calls.push('evaluate');
        return tsFieldEngine.evaluate(...args);
      },
    };
    const ctx = {
      kernel: null,
      ids: { next: (prefix: string) => `${prefix}-x` },
      registry: () => undefined,
      projectDepth: 0,
      recipeDepth: 0,
      replayCache: null,
      fieldEngine: counting,
    };
    const made = execute(field.doc, 'create_implicit_body', { field: field.id, voxel: 1 }, ctx);
    expect((made.data as { provenance: { engine: string } }).provenance.engine).toBe('ts');
    expect(calls).toContain('mesh');
    execute(made.document, 'implicit_properties', { id: field.id }, ctx);
    execute(made.document, 'evaluate_field', { field: field.id, points: [[0, 0, 0]] }, ctx);
    expect(calls).toEqual(expect.arrayContaining(['measure', 'evaluate']));
    setFieldEngine(counting);
    const installed = execute(field.doc, 'evaluate_field', { field: field.id, points: [[0, 0, 0]] });
    expect((installed.data as { provenance: { engine: string } }).provenance.engine).toBe('counting');
    setFieldEngine(null);
  });
});

describe('node-exact zeros', () => {
  it('a lattice sampled on its own nodes has no zero-area triangles and exports as a closed manifold 3MF', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
    const gyroid = ok(box.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'network',
      level: 0,
      cellSize: 8,
      origin: [0, 0, 0],
      region: box.id,
    });
    const body = ok(gyroid.doc, 'create_implicit_body', { field: gyroid.id, voxel: 1 });
    const entity = body.doc.entities[body.id];
    if (entity?.kind !== 'mesh') throw new Error('mesh expected');
    const { positions, indices } = entity.mesh;
    let flat = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const p = [0, 1, 2].map((k) => [0, 1, 2].map((axis) => positions[3 * (indices[t + k] ?? 0) + axis] ?? 0));
      const u = [0, 1, 2].map((axis) => (p[1]?.[axis] ?? 0) - (p[0]?.[axis] ?? 0));
      const v = [0, 1, 2].map((axis) => (p[2]?.[axis] ?? 0) - (p[0]?.[axis] ?? 0));
      const area = Math.hypot(
        (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
        (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
        (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
      );
      if (area < 1e-9) flat += 1;
    }
    expect(flat).toBe(0);
    expect(body.data['closedManifold']).toBe(true);
    const exported = ok(body.doc, 'export_3mf', { entityIds: [body.id] });
    expect(exported.result.summary).not.toContain('Not closed manifold');
  });
});

describe('derivation guard (IMP_DERIVED_READ_ONLY)', () => {
  const { body } = sphereBody();

  it.each([
    ['move_entities', { ids: [body.id], delta: [1, 0, 0] }],
    ['delete_entities', { ids: [body.id] }],
    ['scale_entity', { id: body.id, factor: 2 }],
    ['set_entity_name', { id: body.id, name: 'mine' }],
  ])('refuses %s on the derived mesh', (name, params) => {
    const result = execute(body.doc, name, params);
    expect(result.summary).toContain('IMP_DERIVED_READ_ONLY');
    expect(result.error?.code).toBe('IMP_DERIVED_READ_ONLY');
    expect(result.document).toBe(body.doc);
    expect(result.affected).toEqual([]);
  });

  it('lets other entities change and a new realisation of the same field replace nothing', () => {
    const box = ok(body.doc, 'add_box', { size: [1, 1, 1] });
    const moved = execute(box.doc, 'move_entities', { ids: [box.id], delta: [1, 0, 0] });
    expect(moved.rejected).toBeUndefined();
  });
});

describe('persistence (D3, VC-IMP-48)', () => {
  it('saves the recipe and hash, not the triangles, and reloads the identical mesh', () => {
    const { body } = sphereBody(5, 0.5);
    const lean = serializeDocument(body.doc);
    const full = serializeDocument(body.doc, { includeDerived: true });
    expect(lean).not.toContain('"positions"');
    expect(full.length - lean.length).toBeGreaterThan(20_000);
    const withoutBody = serializeDocument(ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 5 }).doc);
    expect(lean.length - withoutBody.length).toBeLessThan(20_000);
    const loaded = deserializeDocument(lean);
    expect(JSON.stringify(loaded.entities[body.id])).toBe(JSON.stringify(body.doc.entities[body.id]));
    expect(loaded.implicit?.bodies[body.id]?.contentHash).toBe(body.data['contentHash']);
    expect(loaded.order).toContain(body.id);
    const rebuilt = ok(loaded, 'create_implicit_body', { field: body.doc.implicit?.bodies[body.id]?.field ?? '', voxel: 0.5 });
    expect(rebuilt.data['contentHash']).toBe(body.data['contentHash']);
  });

  it('keeps hidden sources through a round trip and survives a body whose mesh cannot be reproduced', () => {
    const box = ok(empty(), 'add_box', { size: [4, 4, 4] });
    const field = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, hideSource: [box.id] });
    const loaded = deserializeDocument(serializeDocument(body.doc));
    expect(loaded.entities[box.id]?.layerId).toBe('layer-implicit-hidden');
    expect(loaded.entities[body.id]?.kind).toBe('mesh');
    const raw = JSON.parse(serializeDocument(body.doc)) as {
      document: Record<string, unknown> & { implicit: { bodies: Record<string, { contentHash: string }> } };
    };
    const stale = JSON.parse(JSON.stringify(raw)) as typeof raw;
    const record = stale.document.implicit.bodies[body.id];
    if (record === undefined) throw new Error('body record expected');
    record.contentHash = 'deadbeef';
    const reloaded = deserializeDocument(JSON.stringify(stale));
    expect(reloaded.entities[body.id]?.kind).toBe('mesh');
    expect(reloaded.implicit?.bodies[body.id]?.contentHash).toBe(body.data['contentHash']);
  });

  it('hashes: a tetra body keeps its hash, a dual-contouring body carries the mesher revision, and a body stored with the old dual-contouring hash is stale and re-derives (05 IMP 14.10)', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const tetra = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    expect(tetra.data['contentHash']).toBe('b18e8ccea66a86d6ba639135fa0455d590a8035cfcdfad820db7d6c95b559179');
    const dc = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5, mesher: 'dual_contouring' });
    const legacy = 'cb157d3b2c66888860e3ff5383245213e6c6e840268613a38b69ab964e3fa8e6';
    expect(dc.data['contentHash']).toBe('3c42f1123517b5db0785a74e875660c378adff65b7cb086ccd7a5294855e5615');
    expect(dc.data['contentHash']).not.toBe(legacy);
    const raw = JSON.parse(serializeDocument(dc.doc)) as {
      document: Record<string, unknown> & { implicit: { bodies: Record<string, { contentHash: string }> } };
    };
    const record = raw.document.implicit.bodies[dc.id];
    if (record === undefined) throw new Error('body record expected');
    record.contentHash = legacy;
    const reloaded = deserializeDocument(JSON.stringify(raw));
    expect(reloaded.implicit?.bodies[dc.id]?.contentHash).toBe(dc.data['contentHash']);
  });

  it('rejects a malformed implicit slice with named errors', () => {
    const { body } = sphereBody();
    const raw = JSON.parse(serializeDocument(body.doc)) as { document: Record<string, unknown> };
    const broken = (patch: (slice: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(raw)) as typeof raw;
      patch(copy.document['implicit'] as Record<string, unknown>);
      return JSON.stringify(copy);
    };
    expect(() => deserializeDocument(broken((slice) => (slice['version'] = 2)))).toThrow(/implicit: malformed slice/);
    expect(() =>
      deserializeDocument(broken((slice) => ((slice['fields'] as Record<string, unknown>)['fld-x'] = { id: 'other', op: 'nope' }))),
    ).toThrow(/is not a valid node/);
    expect(() =>
      deserializeDocument(
        broken(
          (slice) =>
            ((slice['fields'] as Record<string, unknown>)[Object.keys(slice['fields'] as object)[0] ?? ''] = {
              id: Object.keys(slice['fields'] as object)[0],
              op: 'sphere',
            }),
        ),
      ),
    ).toThrow();
    expect(() => deserializeDocument(broken((slice) => ((slice['bodies'] as Record<string, unknown>)['x'] = { id: 'x' })))).toThrow(
      /body 'x' is malformed/,
    );
  });

  it('replay_history re-derives the same body ids and mesh', () => {
    const { body } = sphereBody();
    const replayed = execute(body.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(Object.keys(replayed.document.implicit?.bodies ?? {})).toEqual([body.id]);
    expect(replayed.document.implicit?.bodies[body.id]?.contentHash).toBe(body.data['contentHash']);
  });
});
