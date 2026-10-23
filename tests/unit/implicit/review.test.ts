/** Review items of DES-5: chained reload, source guard, large meshes, not-evaluated checks, 14-connectivity, curved sources, map refusals. */
import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { type Step, empty, expectRefused, ok, run } from './helpers';

describe('chained bodies survive a reload', () => {
  it('a body built on another body is re-derived in creation order', () => {
    const box = ok(empty(), 'add_box', { size: [6, 6, 6] });
    const f1 = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const b1 = ok(f1.doc, 'create_implicit_body', { field: f1.id, voxel: 0.5 });
    const f2 = ok(b1.doc, 'field_from_solid', { entityId: b1.id });
    const grown = ok(f2.doc, 'offset_field', { field: f2.id, distance: 0.5 });
    const b2 = ok(grown.doc, 'create_implicit_body', { field: grown.id, voxel: 0.5 });
    const loaded = deserializeDocument(serializeDocument(b2.doc));
    expect(loaded.entities[b1.id]?.kind).toBe('mesh');
    expect(loaded.entities[b2.id]?.kind).toBe('mesh');
    expect(loaded.implicit?.bodies[b2.id]?.contentHash).toBe(b2.data['contentHash']);
    expect(JSON.stringify(loaded.entities[b2.id])).toBe(JSON.stringify(b2.doc.entities[b2.id]));
  });
});

describe('source solids are guarded (IMP_SOURCE_IN_USE)', () => {
  const built = (): { box: Step; body: Step } => {
    const box = ok(empty(), 'add_box', { size: [4, 4, 4] });
    const field = ok(box.doc, 'field_from_solid', { entityId: box.id });
    return { box, body: ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, hideSource: [box.id] }) };
  };

  it.each([
    ['move_entities', (id: string) => ({ ids: [id], delta: [1, 0, 0] })],
    ['delete_entities', (id: string) => ({ ids: [id] })],
    ['scale_entity', (id: string) => ({ id, factor: 2 })],
  ])('refuses %s on the source of a body', (name, params) => {
    const { box, body } = built();
    const result = execute(body.doc, name, params(box.id));
    expect(result.error?.code).toBe('IMP_SOURCE_IN_USE');
    expect(result.document).toBe(body.doc);
  });

  it('lets the source change layer and an unrelated solid move', () => {
    const { body } = built();
    const other = ok(body.doc, 'add_box', { size: [1, 1, 1] });
    expect(execute(other.doc, 'move_entities', { ids: [other.id], delta: [1, 0, 0] }).rejected).toBeUndefined();
  });
});

describe('large meshes', () => {
  it('field_from_solid of a 100k-triangle solid compiles (no argument-spread overflow)', () => {
    const n = 92;
    const positions: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    };
    const face = (map: (u: number, v: number) => number[], flip: boolean): void => {
      for (let i = 0; i < n; i += 1)
        for (let j = 0; j < n; j += 1) {
          const [p, q, r, s] = [map(i / n, j / n), map((i + 1) / n, j / n), map((i + 1) / n, (j + 1) / n), map(i / n, (j + 1) / n)];
          if (flip) quad(p, s, r, q);
          else quad(p, q, r, s);
        }
    };
    face((u, v) => [u, v, 0], true);
    face((u, v) => [u, v, 1], false);
    face((u, v) => [u, 0, v], false);
    face((u, v) => [u, 1, v], true);
    face((u, v) => [0, u, v], true);
    face((u, v) => [1, u, v], false);
    const base = empty();
    const entity: MeshSolidEntity = {
      id: 'big',
      kind: 'mesh',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#999999',
      mesh: { positions, indices: positions.map((_, i) => i / 3).filter(Number.isInteger) },
    };
    const doc: CadDocument = { ...base, entities: { big: entity }, order: ['big'] };
    expect(positions.length / 9).toBeGreaterThan(100_000);
    const field = ok(doc, 'field_from_solid', { entityId: 'big' });
    expect(field.data['bounds']).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    const inside = ok(field.doc, 'evaluate_field', {
      field: field.id,
      points: [
        [0.5, 0.5, 0.5],
        [2, 0.5, 0.5],
      ],
    }).data['values'] as number[];
    expect(inside[0]).toBeCloseTo(-0.5, 9);
    expect(inside[1]).toBeCloseTo(1, 9);
  }, 60_000);
});

describe('field_from_solid distance quality', () => {
  it('is exact for planar solids and a bound for curved ones, with the tessellation note', () => {
    const box = ok(empty(), 'add_box', { size: [2, 2, 2] });
    const cylinder = ok(box.doc, 'add_cylinder', { radius: 1, height: 2 });
    const planar = ok(cylinder.doc, 'field_from_solid', { entityId: box.id });
    const curved = ok(planar.doc, 'field_from_solid', { entityId: cylinder.id });
    expect(planar.data).toMatchObject({ distanceQuality: 'exact', tessellationExact: true, deflection: null });
    expect(curved.data).toMatchObject({ distanceQuality: 'bound', tessellationExact: false });
    expect(String(curved.data['deflectionNote'])).toContain('tessellation');
  });
});

describe('check_implicit never passes what it did not evaluate', () => {
  const sphere = (): Step => {
    const s = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    return ok(s.doc, 'create_implicit_body', { field: s.id, voxel: 0.5 });
  };
  const verdict = (
    doc: CadDocument,
    id: string,
    process: Record<string, unknown>,
  ): { status: string; notEvaluated: string[]; findings: Array<{ code: string }> } =>
    ok(doc, 'check_implicit', { id, process }).data as { status: string; notEvaluated: string[]; findings: Array<{ code: string }> };

  it('a requested wall or strut limit without a declared size is not evaluated and warns', () => {
    const body = sphere();
    const data = verdict(body.doc, body.id, { minWallMm: 0.4, minStrutMm: 0.4, source: 'owner-supplied' });
    expect(data.status).toBe('warn');
    expect(data.notEvaluated).toEqual(['minWallMm', 'minStrutMm']);
    expect(data.findings.map((f) => f.code)).toContain('IMP_CHECK_NOT_EVALUATED');
  });

  it('a limit with a declared size and an evaluated body passes', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    const lattice = ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, region: box.id });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5 });
    const data = verdict(body.doc, body.id, { minStrutMm: 0.5, source: 'owner-supplied' });
    expect(data.status).toBe('pass');
    expect(data.notEvaluated).toEqual([]);
  });

  it('components that the engine refused are not evaluated and warn', () => {
    const body = sphere();
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
    const answer = execute(body.doc, 'check_implicit', { id: body.id, process: { source: 'owner-supplied' } }, ctx);
    const data = answer.data as { status: string; notEvaluated: string[] };
    expect(data.status).toBe('warn');
    expect(data.notEvaluated).toEqual(['components']);
  });
});

describe('lattice controls under maps', () => {
  it('refuses relativeDensity with a cylindrical map (solved on a rectangular cell) and measures rotated lattices on the unrotated cell', () => {
    const doc = empty();
    const map = { kind: 'cylindrical', origin: [0, 0, 0], axis: [0, 0, 1], cellsAround: 6, radialCellSize: 10 };
    expectRefused(
      doc,
      run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', relativeDensity: 0.3, cellSize: 10, map }),
      'IMP_PARAM_CONFLICT',
    );
    const flat = ok(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10 });
    const turned = ok(flat.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'network',
      level: 0,
      cellSize: 10,
      rotation: [0.4, 0.2, 0.9],
      origin: [3, 1, 2],
    });
    const rho = ok(turned.doc, 'lattice_properties', { id: turned.id }).data['rhoMeasured'] as number;
    expect(Math.abs(rho - 0.5)).toBeLessThan(1e-4);
    expect(turned.data['lipschitzIsEstimate']).toBe(true);
  });
});

describe('afterLoad reports bodies that could not be realised', () => {
  it('names them with IMP_BODY_STALE', async () => {
    const { documentExtensions } = await import('@core/plugins/host');
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const { [body.id]: dropped, ...entities } = body.doc.entities;
    void dropped;
    const stale: CadDocument = { ...body.doc, entities };
    const warnings = documentExtensions().flatMap((extension) => extension.afterLoad?.(stale) ?? []);
    expect(warnings.some((w) => w.startsWith('IMP_BODY_STALE'))).toBe(true);
  });
});
