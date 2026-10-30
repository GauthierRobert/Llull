/**
 * VC-IMP-44..46 (05 IMP M4): the native `FieldEngine` (`llull-compute field`) against the TypeScript engine, which is the oracle. The same
 * commands run twice, once per engine; meshes must be identical vertex for vertex and triangle for triangle, values and measures bit for bit,
 * only the provenance differs. The native engine also meshes grids above the TS 2^21 node budget. Native runs need llull-compute (cargo build
 * --release -p llull-compute in solver/) and are skipped with a logged reason otherwise; the fallback and installation tests always run.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { FieldBuilder } from '@core/geometry/field/build';
import type { FieldOp } from '@core/geometry/field/program';
import { getFieldEngine, setFieldEngine } from '@core/geometry/field/engine';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import { compileField } from '@implicit/compile';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { type CadDocument, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import {
  NATIVE_DUAL_CONTOURING_MAX_SAMPLES,
  NATIVE_FIELD_LIMITS,
  createNativeFieldEngine,
  installFieldEngine,
} from '../src/native/fieldEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('fieldNative: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine: FieldEngine | null = BINARY === null ? null : createNativeFieldEngine({ binary: BINARY });

const ctxOf = (fieldEngine: FieldEngine): ExecutionContext => ({ ...defaultContext(), fieldEngine });

interface Step {
  readonly doc: CadDocument;
  readonly id: string;
  readonly result: CommandResult;
  readonly data: Record<string, unknown>;
}

function step(doc: CadDocument, name: string, params: Record<string, unknown>, fieldEngine: FieldEngine = tsFieldEngine): Step {
  const result = execute(doc, name, params, ctxOf(fieldEngine));
  if (result.error !== undefined) throw new Error(`${name} refused: ${result.summary}`);
  return { doc: result.document, id: result.affected[0] ?? '', result, data: (result.data ?? {}) as Record<string, unknown> };
}

/** The pack's three field families in one document: smooth blend, clipped gyroid + octet lattices, a solid-sourced field. */
function scene(): { doc: CadDocument; fields: Record<string, string> } {
  let doc = createEmptyDocument();
  const add = (name: string, params: Record<string, unknown>): string => {
    const s = step(doc, name, params);
    doc = s.doc;
    return s.id;
  };
  const a = add('add_field_primitive', { shape: 'sphere', radius: 4 });
  const b = add('add_field_primitive', { shape: 'box', size: [5, 5, 5], position: [3, 0, 0], rounding: 0.5 });
  const blend = add('combine_fields', { op: 'union', a, b, blend: { kind: 'quadratic', radius: 1.5 } });
  const exp = add('combine_fields', { op: 'union', a, b, blend: { kind: 'exponential', radius: 1 } });
  const cell = add('add_field_primitive', { shape: 'box', size: [12, 12, 12], position: [6, 6, 6] });
  const gyroid = add('add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.8, cellSize: 6, origin: [0, 0, 0], region: cell });
  const diamond = add('add_tpms_lattice', { kind: 'diamond', form: 'network', level: 0.1, cellSize: [6, 6, 6], region: cell });
  const octet = add('add_strut_lattice', { cell: 'octet', cellSize: 6, radius: 0.4, origin: [0, 0, 0], region: cell });
  const box = add('add_box', { size: [8, 8, 8] });
  const solid = add('field_from_solid', { entityId: box });
  const shell = add('shell_field', { field: solid, thickness: 1, side: 'inside' });
  return { doc, fields: { blend, exp, gyroid, diamond, octet, solid, shell } };
}

const SCENE = scene();
const VOXEL: Record<string, number> = { blend: 0.4, exp: 0.4, gyroid: 0.3, diamond: 0.3, octet: 0.25, solid: 0.5, shell: 0.4 };

describe('native field engine parity (VC-IMP-44, 45)', () => {
  for (const name of Object.keys(SCENE.fields)) {
    native(`${name}: identical mesh, hash inputs, volume and provenance differs only by engine`, () => {
      if (engine === null) return;
      const field = SCENE.fields[name] as string;
      const params = { field, voxel: VOXEL[name] };
      const ts = step(SCENE.doc, 'create_implicit_body', params);
      const nat = step(SCENE.doc, 'create_implicit_body', params, engine);
      const a = ts.doc.entities[ts.id] as MeshSolidEntity;
      const b = nat.doc.entities[nat.id] as MeshSolidEntity;
      expect(b.mesh.indices).toEqual(a.mesh.indices);
      expect(b.mesh.positions.length).toBe(a.mesh.positions.length);
      expect(b.mesh.positions.filter((v, i) => !Object.is(v, a.mesh.positions[i]))).toEqual([]);
      for (const key of ['triangles', 'vertices', 'volumeMesh', 'area', 'closedManifold']) expect(nat.data[key]).toEqual(ts.data[key]);
      const pa = ts.data['provenance'] as Record<string, unknown>;
      const pb = nat.data['provenance'] as Record<string, unknown>;
      expect([pa['engine'], pb['engine']]).toEqual(['ts', 'llull-field']);
      for (const key of ['samples', 'evaluatedSamples', 'nonFiniteSamples', 'maxVertexResidual', 'prunedFraction'])
        expect(pb[key], key).toEqual(pa[key]);
      expect(nat.data['contentHash']).toBe(ts.data['contentHash']);
    });
  }

  native('evaluate_field: values and distance quality are bit-identical for every field', () => {
    if (engine === null) return;
    const points = Array.from({ length: 400 }, (_, n) =>
      [0, 1, 2].map((axis) => ((0.5 + (n + 1) * [0.8191725, 0.6710436, 0.5497004][axis]!) % 1) * 14 - 1),
    );
    for (const field of Object.values(SCENE.fields)) {
      const ts = step(SCENE.doc, 'evaluate_field', { field, points });
      const nat = step(SCENE.doc, 'evaluate_field', { field, points }, engine);
      expect(nat.data['values']).toEqual(ts.data['values']);
      expect(nat.data['distanceQuality']).toBe(ts.data['distanceQuality']);
    }
  });

  native('implicit_properties and lattice_properties (quadrature, quantile) answer identically', () => {
    if (engine === null) return;
    for (const field of [SCENE.fields['gyroid'], SCENE.fields['octet'], SCENE.fields['blend']] as string[]) {
      const ts = step(SCENE.doc, 'implicit_properties', { id: field, voxel: 0.5 });
      const nat = step(SCENE.doc, 'implicit_properties', { id: field, voxel: 0.5 }, engine);
      expect(nat.data['volume']).toBe(ts.data['volume']);
      expect(nat.data['volumeQuadrature']).toEqual(ts.data['volumeQuadrature']);
    }
    for (const field of [SCENE.fields['gyroid'], SCENE.fields['diamond'], SCENE.fields['octet']] as string[]) {
      const ts = step(SCENE.doc, 'lattice_properties', { id: field });
      const nat = step(SCENE.doc, 'lattice_properties', { id: field }, engine);
      for (const key of Object.keys(ts.data).filter((k) => k !== 'provenance')) expect(nat.data[key], key).toEqual(ts.data[key]);
    }
  });

  native('check_implicit components, trapped voids and tpms relativeDensity inversion agree', () => {
    if (engine === null) return;
    const ts0 = step(SCENE.doc, 'create_implicit_body', { field: SCENE.fields['shell'], voxel: 0.5 });
    const nat0 = step(SCENE.doc, 'create_implicit_body', { field: SCENE.fields['shell'], voxel: 0.5 }, engine);
    const process = { minWallMm: 0.2, minPoreMm: 0.2, source: 'test' };
    const ts = step(ts0.doc, 'check_implicit', { id: ts0.id, process });
    const nat = step(nat0.doc, 'check_implicit', { id: nat0.id, process }, engine);
    expect(nat.data['findings']).toEqual(ts.data['findings']);
    expect(nat.data['status']).toBe(ts.data['status']);
    const density = { kind: 'gyroid', form: 'sheet', relativeDensity: 0.3, cellSize: 5 };
    const a = step(createEmptyDocument(), 'add_tpms_lattice', density);
    const b = step(createEmptyDocument(), 'add_tpms_lattice', density, engine);
    expect(b.data['control']).toEqual(a.data['control']);
  });

  native(
    'an explicit strut set above the BVH threshold (Voronoi, 400+ beams): values, mesh and content hash are bit-identical (05 IMP 14.9)',
    () => {
      if (engine === null) return;
      const box = step(createEmptyDocument(), 'add_field_primitive', { shape: 'box', size: [14, 14, 14], position: [7, 7, 7] });
      const lattice = step(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.1, seed: 5, radius: 0.35 });
      expect(lattice.data['beams'] as number).toBeGreaterThan(400);
      const points = Array.from({ length: 600 }, (_, n) =>
        [0, 1, 2].map((axis) => ((0.5 + (n + 1) * [0.8191725, 0.6710436, 0.5497004][axis]!) % 1) * 16 - 1),
      );
      const ts = step(lattice.doc, 'evaluate_field', { field: lattice.id, points });
      const nat = step(lattice.doc, 'evaluate_field', { field: lattice.id, points }, engine);
      expect(nat.data['values']).toEqual(ts.data['values']);
      const params = { field: lattice.id, voxel: 0.3 };
      const a = step(lattice.doc, 'create_implicit_body', params);
      const b = step(lattice.doc, 'create_implicit_body', params, engine);
      expect(b.data['contentHash']).toBe(a.data['contentHash']);
      expect((b.doc.entities[b.id] as MeshSolidEntity).mesh.indices).toEqual((a.doc.entities[a.id] as MeshSolidEntity).mesh.indices);
    },
  );

  native(
    'native gradient (evaluate_field gradient: true): value and gradient bit-identical for every field of the scene and a Voronoi set (05 IMP 14.10)',
    () => {
      if (engine === null) return;
      const points = Array.from({ length: 300 }, (_, n) =>
        [0, 1, 2].map((axis) => ((0.5 + (n + 1) * [0.8191725, 0.6710436, 0.5497004][axis]!) % 1) * 14 - 1),
      );
      const box = step(createEmptyDocument(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
      const voronoi = step(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.2, seed: 2, radius: 0.3 });
      expect(voronoi.data['beams'] as number).toBeGreaterThan(40);
      const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
        a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));
      for (const [doc, field] of [
        ...Object.values(SCENE.fields).map((id) => [SCENE.doc, id] as const),
        [voronoi.doc, voronoi.id] as const,
      ]) {
        const ts = step(doc, 'evaluate_field', { field, points, gradient: true });
        const nat = step(doc, 'evaluate_field', { field, points, gradient: true }, engine);
        expect(same(nat.data['values'] as number[], ts.data['values'] as number[]), field + ' values').toBe(true);
        expect(same(nat.data['gradients'] as number[], ts.data['gradients'] as number[]), field + ' gradients').toBe(true);
        expect((nat.data['provenance'] as Record<string, unknown>)['engine']).toBe('llull-field');
      }
    },
  );

  native('native gradient of every op, both sides of each condition (degenerate points included), bit for bit', () => {
    if (engine === null) return;
    const meta = { bounds: null, lipschitz: 1, quality: 'exact' } as const;
    const arity: Record<string, number> = {
      add: 2,
      sub: 2,
      mul: 2,
      div: 2,
      neg: 1,
      abs: 1,
      min: 2,
      max: 2,
      sqrt: 1,
      square: 1,
      sin: 1,
      cos: 1,
      atan2: 2,
      floor: 1,
      fract: 1,
      clamp: 3,
      select: 3,
      smin_quad: 3,
      smin_exp: 3,
      chamfer_min: 3,
    };
    const ops = Object.keys(arity) as FieldOp[];
    const grid = [-1.5, -1, -0.5, 0, 0.25, 0.5, 1, 2, 3];
    const points = Float64Array.from(grid.flatMap((x) => grid.flatMap((y) => grid.flatMap((z) => [x, y, z]))));
    for (const op of ops) {
      const b = new FieldBuilder('mm');
      const program = b.finish(b.op(op, ...[b.x(), b.y(), b.z()].slice(0, arity[op])), meta);
      const ts = tsFieldEngine.evaluate(program, points, true);
      const nat = engine.evaluate(program, points, true);
      expect(
        Array.from(nat.values).every((v, i) => Object.is(v, ts.values[i])),
        op + ' values',
      ).toBe(true);
      expect(
        Array.from(nat.gradients ?? []).every((v, i) => Object.is(v, ts.gradients?.[i])),
        op + ' gradients',
      ).toBe(true);
      expect(nat.gradients?.length).toBe(points.length);
    }
  });

  native(
    'native dual contouring: mesh, mesher choice, hash and figures identical to the TS mesher for every field, sharp and falling back alike (05 IMP 14.10)',
    () => {
      if (engine === null) return;
      const box = step(createEmptyDocument(), 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4], rounding: 0 });
      const cut = step(box.doc, 'add_field_primitive', { shape: 'sphere', radius: 5, position: [7, 7, 7] });
      const sharp = step(cut.doc, 'combine_fields', { op: 'subtract', a: box.id, b: cut.id });
      const voronoi = step(sharp.doc, 'add_voronoi_lattice', { region: box.id, density: 0.15, seed: 4, radius: 0.35 });
      const cases: Array<[CadDocument, string, number]> = [
        ...Object.keys(SCENE.fields).map((name): [CadDocument, string, number] => [
          SCENE.doc,
          SCENE.fields[name] as string,
          VOXEL[name] as number,
        ]),
        [sharp.doc, sharp.id, 0.4],
        [voronoi.doc, voronoi.id, 0.3],
      ];
      const seen = new Set<string>();
      let repaired = 0;
      for (const [doc, field, voxel] of cases) {
        const params = { field, voxel, mesher: 'dual_contouring' };
        const ts = step(doc, 'create_implicit_body', params);
        const nat = step(doc, 'create_implicit_body', params, engine);
        const a = ts.doc.entities[ts.id] as MeshSolidEntity;
        const b = nat.doc.entities[nat.id] as MeshSolidEntity;
        const sameMesh =
          a.mesh.indices.length === b.mesh.indices.length &&
          a.mesh.positions.length === b.mesh.positions.length &&
          a.mesh.indices.every((v, i) => v === b.mesh.indices[i]) &&
          a.mesh.positions.every((v, i) => Object.is(v, b.mesh.positions[i]));
        expect(sameMesh, `${field}: ${a.mesh.indices.length / 3} vs ${b.mesh.indices.length / 3} triangles`).toBe(true);
        for (const key of [
          'triangles',
          'vertices',
          'volumeMesh',
          'area',
          'closedManifold',
          'mesher',
          'mesherFallback',
          'dualContouringSplitCells',
          'contentHash',
        ])
          expect(nat.data[key], field + ' ' + key).toEqual(ts.data[key]);
        const pa = ts.data['provenance'] as Record<string, unknown>;
        const pb = nat.data['provenance'] as Record<string, unknown>;
        expect([pa['engine'], pb['engine']]).toEqual(['ts', 'llull-field']);
        for (const key of ['samples', 'evaluatedSamples', 'nonFiniteSamples', 'maxVertexResidual', 'prunedFraction'])
          expect(pb[key], key).toEqual(pa[key]);
        if ((ts.data['dualContouringSplitCells'] as number) > 0) repaired += 1;
        seen.add(String(ts.data['mesher']) + (ts.data['mesherFallback'] === true ? ':fallback' : ''));
      }
      expect([...seen].sort()).toEqual(['dual_contouring', 'tetra:fallback']);
      expect(repaired, 'the octet lattice is repaired cell by cell on both engines').toBeGreaterThan(0);
    },
  );

  native('native dual contouring refuses a grid above its named cap (2^29 nodes) before sampling, with the cap in the refusal', () => {
    if (engine === null) return;
    const sphere = step(createEmptyDocument(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const compiled = compileField(sphere.doc, sphere.id);
    if (!compiled.ok) throw new Error(compiled.message);
    const grid = { min: [0, 0, 0] as const, max: [900, 900, 900] as const, voxel: 1 };
    const refused = engine.mesh(compiled.program, grid, { mesher: 'dual_contouring', maxTriangles: 1000 });
    expect(refused).toMatchObject({ ok: false, code: 'IMP_GRID_BUDGET', limit: NATIVE_DUAL_CONTOURING_MAX_SAMPLES });
  });

  native('randomized trigonometry parity: thousands of points at TPMS scale and in the V8 reduction range, bit for bit', () => {
    if (engine === null) return;
    let seed = 20260101;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const fine = step(createEmptyDocument(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0.1, cellSize: 0.37 }).id;
    const doc = step(
      step(createEmptyDocument(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0.1, cellSize: 0.37 }).doc,
      'add_tpms_lattice',
      { kind: 'schwarz_p', form: 'sheet', thickness: 0.2, cellSize: 2.9 },
    );
    const coarse = doc.id;
    for (const [field, span] of [
      [fine, 300],
      [coarse, 4000],
    ] as const) {
      for (let batch = 0; batch < 3; batch += 1) {
        const points = Array.from({ length: 1000 }, () => [0, 1, 2].map(() => (random() - 0.5) * span));
        const ts = step(doc.doc, 'evaluate_field', { field, points });
        const nat = step(doc.doc, 'evaluate_field', { field, points }, engine);
        expect(nat.data['values'], field).toEqual(ts.data['values']);
      }
    }
  });

  native('arguments beyond the ported sin / cos reduction fall back to the TS engine instead of answering with libm', () => {
    if (engine === null) return;
    const lattice = step(createEmptyDocument(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0.1, cellSize: 0.0001 });
    const points = Array.from({ length: 200 }, (_, n) => [n * 0.7, n * 1.3, 90 - n * 0.4]);
    const ts = step(lattice.doc, 'evaluate_field', { field: lattice.id, points });
    const nat = step(lattice.doc, 'evaluate_field', { field: lattice.id, points }, engine);
    expect(nat.data['values']).toEqual(ts.data['values']);
  });
});

describe('native node sign grid (M5 thickness input)', () => {
  native('measure nodes returns the same inside grid as the TS engine, clipped to a region', () => {
    if (engine === null) return;
    const b = new FieldBuilder('mm');
    const sphere = b.finish(b.shift(b.length3(b.x(), b.y(), b.z()), -3), { bounds: null, lipschitz: 1, quality: 'exact' });
    const c = new FieldBuilder('mm');
    const region = c.finish(c.shift(c.length3(c.shift(c.x(), -1), c.y(), c.z()), -2.5), { bounds: null, lipschitz: 1, quality: 'exact' });
    const grid = { min: [-4, -4, -4], max: [4, 4, 4], voxel: 0.25 } as const;
    for (const clip of [null, region]) {
      const ts = tsFieldEngine.measure(sphere, grid, clip, { kind: 'nodes' });
      const nat = engine.measure(sphere, grid, clip, { kind: 'nodes' });
      if (!ts.ok || ts.kind !== 'nodes' || !nat.ok || nat.kind !== 'nodes') throw new Error('nodes failed');
      expect(nat.nodes).toEqual(ts.nodes);
      expect(Buffer.from(nat.inside).equals(Buffer.from(ts.inside))).toBe(true);
    }
  });
});

describe('native field engine scale (VC-IMP-45, 46)', () => {
  native('meshes a grid above the TS budget that the TS engine refuses before sampling', () => {
    if (engine === null) return;
    const sphere = step(createEmptyDocument(), 'add_field_primitive', { shape: 'sphere', radius: 5 });
    const params = { field: sphere.id, voxel: 0.07 };
    const refused = execute(sphere.doc, 'create_implicit_body', params, ctxOf(tsFieldEngine));
    expect(refused.error?.code).toBe('IMP_GRID_BUDGET');
    const body = step(sphere.doc, 'create_implicit_body', params, engine);
    expect(body.data['closedManifold']).toBe(true);
    const exact = (4 / 3) * Math.PI * 125;
    expect(Math.abs((body.data['volumeMesh'] as number) - exact) / exact).toBeLessThanOrEqual(0.6 * (0.07 / 5) ** 2);
    expect((body.data['provenance'] as Record<string, unknown>)['engine']).toBe('llull-field');
  });

  native('refuses a triangle budget and a grid budget with the TS codes', () => {
    if (engine === null) return;
    const sphere = step(createEmptyDocument(), 'add_field_primitive', { shape: 'sphere', radius: 5 });
    const triangles = execute(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5, maxTriangles: 100 }, ctxOf(engine));
    expect(triangles.error?.code).toBe('IMP_TRIANGLE_BUDGET');
    const tooBig = execute(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.001 }, ctxOf(engine));
    expect(tooBig.error?.code).toBe('IMP_GRID_BUDGET');
    expect(tooBig.document).toBe(sphere.doc);
  });

  native('reports the engine on the process context once installed', () => {
    if (BINARY === null) return;
    const before = getFieldEngine();
    try {
      expect(installFieldEngine({ LLULL_COMPUTE: BINARY })).toBe(true);
      expect(getFieldEngine()?.name).toBe('llull-field');
      expect(getFieldEngine()?.limits).toEqual(NATIVE_FIELD_LIMITS);
    } finally {
      setFieldEngine(before);
    }
  });
});

describe('native field engine without a working binary', () => {
  const missing = createNativeFieldEngine({ binary: 'definitely-not-llull-compute.exe' });

  it('is not installed when the binary is absent', () => {
    expect(createNativeFieldEngine({ env: { LLULL_COMPUTE: '/nonexistent/llull-compute' } })).toBeNull();
    const before = getFieldEngine();
    expect(installFieldEngine({ LLULL_COMPUTE: '/nonexistent/llull-compute' })).toBe(false);
    expect(getFieldEngine()).toBeNull();
    setFieldEngine(before);
  });

  it('answers a small request with the TS engine and refuses a request above the TS budget (IMP_ENGINE_FAILED)', () => {
    if (missing === null) throw new Error('an explicit binary path always builds an engine');
    const sphere = step(createEmptyDocument(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const small = step(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 }, missing);
    expect((small.data['provenance'] as Record<string, unknown>)['engine']).toBe('ts');
    const big = execute(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.04 }, ctxOf(missing));
    expect(big.error?.code).toBe('IMP_ENGINE_FAILED');
    expect(big.document).toBe(sphere.doc);
    const props = step(small.doc, 'implicit_properties', { id: sphere.id, voxel: 0.5 }, missing);
    expect(props.data['volumeQuadrature']).toBeDefined();
  });

  it('delegates malformed programs to the TS engine', () => {
    if (missing === null) throw new Error('an explicit binary path always builds an engine');
    const bad = {
      version: 1 as const,
      instructions: [],
      output: 3,
      constants: [],
      meshes: [],
      strutSets: [],
      bounds: null,
      lipschitz: 1,
      quality: 'exact' as const,
      unit: 'mm',
    };
    const refused = missing.mesh(bad, { min: [0, 0, 0], max: [1, 1, 1], voxel: 0.5 }, { mesher: 'tetra', maxTriangles: 10 });
    expect(refused).toMatchObject({ ok: false, code: 'IMP_ENGINE_FAILED' });
    expect(missing.evaluate(bad, new Float64Array([0, 0, 0]), true).nonFinite).toBe(1);
  });
});
