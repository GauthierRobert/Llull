/** 07 MSH hardening: hostile or damaged input to the ZIP / DEFLATE / PLY / 3MF / OBJ readers, import limits, analysis corner cases and engine failure paths. */

import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyzeIndexedMesh } from '@core/geometry/mesh/analysis';
import { convexHull } from '@core/geometry/mesh/hull';
import { findSelfIntersections } from '@core/geometry/mesh/selfIntersection';
import { createEmptyDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { manifoldMeshEngineOver } from '@kernel-manifold/manifoldMeshEngine';
import { uint8ArrayToBase64 } from '@lib/base64';
import { inflateRaw } from '@lib/inflate';
import { parseMeshFile } from '@lib/meshFormats';
import { isParseFailure, NO_LIMITS } from '@lib/meshFormats/types';
import { zipStore } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import { expectNoOp } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes } from '../../helpers/meshFixtures';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** LSB-first bit stream writer for hand-made DEFLATE blocks. */
function bits(...parts: Array<[value: number, count: number, huffman?: boolean]>): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let used = 0;
  const push = (bit: number): void => {
    acc |= bit << used;
    if (++used === 8) {
      out.push(acc);
      acc = 0;
      used = 0;
    }
  };
  for (const [value, count, huffman] of parts) {
    for (let i = 0; i < count; i++) push(huffman === true ? (value >> (count - 1 - i)) & 1 : (value >> i) & 1);
  }
  if (used > 0) out.push(acc);
  return Uint8Array.from(out);
}

const failureCode = (bytes: Uint8Array, kind?: 'stl' | 'obj' | 'ply' | '3mf', limits = NO_LIMITS): string | null => {
  const result = parseMeshFile(bytes, kind, limits);
  return isParseFailure(result) ? result.code : null;
};
const failureMessage = (bytes: Uint8Array, kind: 'stl' | 'obj' | 'ply' | '3mf'): string => {
  const result = parseMeshFile(bytes, kind);
  return isParseFailure(result) ? result.message : '';
};

describe('inflate', () => {
  it('refuses a reserved block type, a bad stored block, an early distance and out-of-range symbols', () => {
    expect(() => inflateRaw(bits([1, 1], [3, 2]))).toThrow('invalid deflate block');
    expect(() => inflateRaw(Uint8Array.from([0x01, 5, 0, 0, 0]))).toThrow('LEN / NLEN');
    expect(() => inflateRaw(Uint8Array.from([0x01, 5, 0, 0xfa, 0xff, 1, 2]))).toThrow('unexpected end');
    expect(() => inflateRaw(Uint8Array.from([0x01, 5]))).toThrow('unexpected end');
    // fixed block: length symbol 257 (7-bit code 0000001), distance code 0 with nothing written yet
    expect(() => inflateRaw(bits([1, 1], [1, 2], [1, 7, true], [0, 5, true]))).toThrow('invalid deflate distance');
    // fixed block: literal / length symbol 286 (8-bit code 11000110) is not defined
    expect(() => inflateRaw(bits([1, 1], [1, 2], [0b11000110, 8, true]))).toThrow('length symbol');
    // fixed block: 'a' then length 3 (257) then distance symbol 30 (5-bit code 11110) is not defined
    expect(() => inflateRaw(bits([1, 1], [1, 2], [0x30 + 0x61, 8, true], [1, 7, true], [0b11110, 5, true]))).toThrow('distance symbol');
  });

  it('refuses truncated streams and an output beyond the limit, and writes into a growing buffer', () => {
    const data = text('vertex 1 2 3\n'.repeat(5000));
    const packed = deflateRawSync(data, { level: 9 });
    expect(() => inflateRaw(packed.subarray(0, packed.length >> 1))).toThrow();
    expect(() => inflateRaw(packed, 1000)).toThrow('size limit');
    expect(inflateRaw(packed)).toHaveLength(data.length);
    expect(() => inflateRaw(deflateRawSync(text('a'.repeat(100)), { level: 0 }), 10)).toThrow('size limit');
  });
});

function patched(bytes: Uint8Array, edit: (view: DataView, centralAt: number) => void, entry = 0): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  let central = 0;
  for (let seen = 0; ; central++) {
    if (view.getUint32(central, true) === 0x02014b50 && seen++ === entry) break;
  }
  edit(view, central);
  return copy;
}

describe('zip reader', () => {
  const archive = zipStore([
    { name: 'dir/', data: new Uint8Array(0) },
    { name: 'a.txt', data: text('alpha') },
    { name: 'b.model', data: text('beta') },
  ]);

  it('skips directory entries and unselected entries, which are never inflated', () => {
    expect(unzip(archive).map((e) => e.name)).toEqual(['a.txt', 'b.model']);
    expect(unzip(archive, { select: (name) => name.endsWith('.model') }).map((e) => e.name)).toEqual(['b.model']);
  });

  it('refuses encrypted entries, unknown compression, bad signatures and entries beyond the archive', () => {
    expect(() => unzip(patched(archive, (v, c) => v.setUint16(c + 8, 1, true)))).toThrow('encrypted');
    expect(() => unzip(patched(archive, (v, c) => v.setUint16(c + 10, 99, true), 1))).toThrow('unsupported compression');
    expect(() => unzip(patched(archive, (v, c) => v.setUint32(c, 0, true)))).toThrow('central directory');
    expect(() => unzip(patched(archive, (v, c) => v.setUint32(c + 42, 0xffffff, true), 1))).toThrow('corrupt ZIP entry');
    expect(() => unzip(patched(archive, (v, c) => v.setUint32(c + 20, 0xffffff, true), 1))).toThrow('beyond the archive');
    expect(() => unzip(text('not a zip at all, long enough to scan for a record'))).toThrow('not a ZIP');
  });

  it('caps what the selected entries may inflate to (zip bomb) and ignores a corrupt entry nobody selected', () => {
    const bomb = zipStore([{ name: 'big.model', data: new Uint8Array(1 << 16) }]);
    expect(() => unzip(bomb, { maxBytes: 1000 })).toThrow();
    const pair = zipStore([
      { name: 'one.model', data: new Uint8Array(600) },
      { name: 'two.model', data: new Uint8Array(600) },
    ]);
    expect(() => unzip(pair, { maxBytes: 1000 })).toThrow('byte limit');
    const damaged = patched(archive, (v, c) => v.setUint16(c + 10, 8, true));
    expect(() => unzip(damaged, { select: () => false })).not.toThrow();
  });
});

describe('PLY hardening', () => {
  const header = (extra = '', vertices = 3): string =>
    `ply\nformat ascii 1.0\nelement vertex ${vertices}\nproperty float x\nproperty float y\nproperty float z\n${extra}element face 1\nproperty list uchar int vertex_indices\nend_header\n`;

  it('refuses malformed headers and counts with named messages', () => {
    expect(failureMessage(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty list uchar\nend_header\n'), 'ply')).toContain('bad list');
    expect(failureMessage(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty quad x\nend_header\n'), 'ply')).toContain(
      'unknown property type',
    );
    expect(failureMessage(text('ply\nformat ascii 1.0\nelement vertex lots\nend_header\n'), 'ply')).toContain('bad element count');
    expect(failureMessage(text('ply\nformat ascii 1.0\nelement vertex 4000000000\nproperty float x\nend_header\n'), 'ply')).toContain(
      'claims',
    );
    expect(failureMessage(text(header().replace('format ascii', 'format gzip')), 'ply')).toContain('gzip');
    expect(failureMessage(text('no magic\nend_header\n'), 'ply')).toContain('magic');
  });

  it('refuses vertices without x, y or z, bad numbers and out-of-range faces', () => {
    const noZ =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0\n1 0\n0 1\n3 0 1 2\n';
    expect(failureMessage(text(noZ), 'ply')).toContain('lack x, y or z');
    expect(failureMessage(text(`${header()}0 0 zero\n`), 'ply')).toContain('bad number');
    expect(failureMessage(text(`${header()}0 0 0\n1 0 0\n0 1 0\n3 0 1 7\n`), 'ply')).toContain('outside');
  });

  it('is not fooled by end_header inside a comment and skips elements that have no properties', () => {
    const body = '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
    const tricky = `ply\nformat ascii 1.0\ncomment end_header\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement marker 50\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n${body}`;
    const result = parseMeshFile(text(tricky), 'ply');
    expect(isParseFailure(result)).toBe(false);
    expect(isParseFailure(result) ? [] : result.bodies[0]?.triangles).toEqual([0, 1, 2]);
  });
});

const model = (objects: string, build: string, unit = 'millimeter'): Uint8Array =>
  zipStore([
    { name: '3D/3dmodel.model', data: text(`<model unit="${unit}"><resources>${objects}</resources><build>${build}</build></model>`) },
  ]);
const tetra = (id: string, extra = ''): string =>
  `<object id="${id}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh>${extra}</object>`;

describe('3MF hardening', () => {
  it('reads a model part under another name and ignores a cyclic component chain at the depth cap', () => {
    const cyclic = `<object id="2"><components><component objectid="2"/><component objectid="1"/></components></object>`;
    const archive = zipStore([
      {
        name: 'Models/part.model',
        data: text(`<model><resources>${tetra('1')}${cyclic}</resources><build><item objectid="2"/></build></model>`),
      },
    ]);
    const result = parseMeshFile(archive, '3mf');
    expect(isParseFailure(result)).toBe(false);
    expect(isParseFailure(result) ? 0 : result.bodies.length).toBeGreaterThan(0);
  });

  it('refuses bodies and triangles beyond the limits while expanding components (MESH_IMPORT_TOO_LARGE)', () => {
    const many = `<object id="2"><components>${'<component objectid="1"/>'.repeat(50)}</components></object>`;
    const archive = model(tetra('1') + many, '<item objectid="2"/>');
    expect(failureCode(archive, '3mf', { ...NO_LIMITS, maxBodies: 10 })).toBe('MESH_IMPORT_TOO_LARGE');
    expect(failureCode(archive, '3mf', { ...NO_LIMITS, maxTriangles: 100 })).toBe('MESH_IMPORT_TOO_LARGE');
    expect(failureCode(archive, '3mf')).toBeNull();
  });

  it('refuses a model that inflates beyond the byte limit before expanding it', () => {
    const bomb = zipStore([{ name: '3D/3dmodel.model', data: new Uint8Array(1 << 17) }]);
    expect(failureCode(bomb, '3mf', { ...NO_LIMITS, maxBytes: 1000 })).toBe('MESH_IMPORT_PARSE');
  });

  it('reports a model with no mesh as empty and objects without a build as bodies', () => {
    expect(failureCode(model('<object id="1"/>', ''), '3mf')).toBe('MESH_IMPORT_EMPTY');
    expect(failureCode(model(tetra('1') + tetra('2'), ''), '3mf')).toBeNull();
  });
});

describe('OBJ hardening', () => {
  it('names an unnamed group, keeps the concave polygon area and orientation, and falls back to a fan for a degenerate polygon', () => {
    const lshape = 'v 0 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nv 1 2 0\nv 0 2 0\ng\nf 1 2 3 4 5 6\n';
    const result = parseMeshFile(text(lshape), 'obj');
    if (isParseFailure(result)) throw new Error(result.message);
    const body = result.bodies[0];
    expect(body?.groups).toEqual([{ name: 'group0', start: 0, end: 4 }]);
    expect(body?.triangles).toHaveLength(12);
    const area = analyzeIndexedMesh(body?.positions ?? [], body?.triangles ?? [], { selfIntersections: false, maxListed: 0 }).area;
    expect(area).toBeCloseTo(3, 12);
    const signed = (body?.triangles ?? []).reduce((sum, _, k, all) => {
      if (k % 3 !== 0) return sum;
      const p = (i: number): number[] => body?.positions.slice((all[k + i] as number) * 3, (all[k + i] as number) * 3 + 3) ?? [];
      const [a, b, c] = [p(0), p(1), p(2)];
      return (
        sum + (((b[0] ?? 0) - (a[0] ?? 0)) * ((c[1] ?? 0) - (a[1] ?? 0)) - ((c[0] ?? 0) - (a[0] ?? 0)) * ((b[1] ?? 0) - (a[1] ?? 0))) / 2
      );
    }, 0);
    expect(signed).toBeCloseTo(3, 12);
    const flat = parseMeshFile(text('v 0 0 0\nv 1 0 0\nv 2 0 0\nv 3 0 0\nf 1 2 3 4\n'), 'obj');
    expect(isParseFailure(flat) ? 0 : flat.bodies[0]?.triangles.length).toBe(6);
  });
});

describe('import_mesh_file limits and naming', () => {
  const run = (bytes: Uint8Array, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(createEmptyDocument(), 'import_mesh_file', { base64: uint8ArrayToBase64(bytes), ...extra });

  it('refuses more bodies and more triangles than the import limits with MESH_IMPORT_TOO_LARGE', () => {
    const items = '<item objectid="1"/>'.repeat(10_001);
    expect(run(model(tetra('1'), items)).error?.code).toBe('MESH_IMPORT_TOO_LARGE');
    const triangles = '<triangle v1="0" v2="1" v3="2"/>'.repeat(1000);
    const heavy = `<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles>${triangles}</triangles></mesh></object>`;
    expect(run(model(heavy, '<item objectid="1"/>'.repeat(2001))).error?.code).toBe('MESH_IMPORT_TOO_LARGE');
  });

  it('numbers several bodies after the given name and keeps names from the file otherwise', () => {
    const archive = model(
      tetra('1').replace('<object id="1">', '<object id="1" name="plate">'),
      '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>',
    );
    const named = run(archive, { name: 'part' });
    expect(named.affected.map((id) => named.document.entities[id]?.name)).toEqual(['part 1', 'part 2']);
    const fromFile = run(archive);
    expect(fromFile.affected.map((id) => fromFile.document.entities[id]?.name)).toEqual(['plate 1', 'plate 2']);
  });

  it('rejects text that is not valid base64 and both inputs at once', () => {
    expect(execute(createEmptyDocument(), 'import_mesh_file', { base64: '@@@@', units: 'mm' }).error?.code).toBe('MESH_PARAM_INVALID');
    expect(execute(createEmptyDocument(), 'import_mesh_file', { base64: 'AAAA', text: 'x', units: 'mm' }).error?.code).toBe(
      'MESH_PARAM_INVALID',
    );
  });
});

describe('analysis corner cases', () => {
  const analyze = (positions: number[], indices: number[]): ReturnType<typeof analyzeIndexedMesh> =>
    analyzeIndexedMesh(positions, indices, { selfIntersections: false, maxListed: 5 });

  it('an all-degenerate mesh is not closed and has no shells; degenerate faces add nothing to the Euler count', () => {
    const flat = analyze([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 0, 1, 1, 1, 2]);
    expect([flat.closed, flat.shellCount, flat.degenerateFaces, flat.eulerCharacteristic]).toEqual([false, 0, 2, 0]);
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const withExtra = analyze(box.positions, [...box.indices, 0, 0, 1]);
    expect(withExtra.eulerCharacteristic).toBe(2);
    expect(withExtra.shellCount).toBe(1);
    expect(withExtra.closed).toBe(true);
  });

  it('reports no volume or genus for a shell whose faces disagree on orientation', () => {
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const indices = [...box.indices];
    [indices[1], indices[2]] = [indices[2] as number, indices[1] as number];
    const mixed = analyze(box.positions, indices);
    expect(mixed.orientationConsistent).toBe(false);
    expect(mixed.volume).toBeNull();
    expect(mixed.shells[0]?.genus).toBeNull();
    expect(mixed.genus).toBeNull();
  });

  it('finds the crossing of a huge triangle with many small ones without filling the grid', () => {
    const positions = [-1000, -1000, 0, 1000, -1000, 0, 0, 1000, 0];
    const indices = [0, 1, 2];
    const pins = cuboid([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
    for (let i = 0; i < 40; i++) {
      const base = positions.length / 3;
      for (let v = 0; v < pins.positions.length; v += 3)
        positions.push((pins.positions[v] as number) + i * 3, pins.positions[v + 1] as number, pins.positions[v + 2] as number);
      indices.push(...pins.indices.map((index) => index + base));
    }
    const found = findSelfIntersections(positions, indices, 3);
    expect(found.count).toBeGreaterThanOrEqual(40);
    expect(found.pairs).toHaveLength(3);
  });

  it('hulls tens of thousands of points through face adjacency', () => {
    const points: number[] = [];
    for (let i = 0; i < 30_000; i++) {
      const [u, v] = [Math.acos(1 - (2 * (i + 0.5)) / 30_000), i * 2.399963229728653];
      points.push(10 * Math.sin(u) * Math.cos(v), 10 * Math.sin(u) * Math.sin(v), 10 * Math.cos(u));
    }
    const hull = convexHull(points);
    const analysis = analyzeIndexedMesh(hull?.positions ?? [], hull?.triangles ?? [], { selfIntersections: false, maxListed: 0 });
    expect(analysis.closed).toBe(true);
    expect(analysis.eulerCharacteristic).toBe(2);
    expect(analysis.volume as number).toBeGreaterThan(4150);
  });
});

describe('results keep the base fields of the entity they replace', () => {
  it('copies material, pattern seed, tags and (at the identity transform) decals; drops decals once the source was placed', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [4, 4, 4]));
    const id = ids[0] as string;
    const source = doc.entities[id] as MeshSolidEntity;
    const decal = { id: 'd', text: 'x', position: [0, 0, 0], normal: [0, 0, 1], width: 1, height: 1, depth: 0.1 };
    const decorated = {
      ...doc,
      entities: {
        ...doc.entities,
        [id]: { ...source, materialId: 'steel', patternSourceId: 'seed', tags: ['a'], decals: [decal] } as unknown as MeshSolidEntity,
      },
    };
    const identity = execute(decorated, 'subdivide_mesh', { id, method: 'midpoint' }).document.entities[id] as MeshSolidEntity;
    expect(identity).toMatchObject({ materialId: 'steel', patternSourceId: 'seed', tags: ['a'] });
    expect(identity.decals).toHaveLength(1);
    const placedDoc = {
      ...decorated,
      entities: {
        ...decorated.entities,
        [id]: { ...(decorated.entities[id] as MeshSolidEntity), position: [1, 0, 0] as [number, number, number] },
      },
    };
    const placed = execute(placedDoc, 'subdivide_mesh', { id, method: 'midpoint' }).document.entities[id] as MeshSolidEntity;
    expect(placed.decals).toBeUndefined();
    expect(placed.materialId).toBe('steel');
  });
});

describe('Manifold engine failure paths', () => {
  const mesh = cuboid([0, 0, 0], [2, 2, 2]);
  const solidStub = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: () => 'NoError',
    delete: () => undefined,
    isEmpty: () => false,
    getMesh: () => {
      throw new Error('WASM exploded');
    },
    ...overrides,
  });
  const api = (solid: Record<string, unknown>): unknown => ({ Manifold: { ofMesh: () => solid, levelSet: () => solid }, Mesh: class {} });
  const input = { mesh };

  it('turns an engine exception into MESH_BOOLEAN_FAILED and still frees every object', () => {
    let freed = 0;
    const solid = solidStub({ delete: () => freed++, add: () => solidStub({ delete: () => freed++ }) });
    const engine = manifoldMeshEngineOver(api(solid));
    const result = engine.run(input, { op: 'boolean', kind: 'union', others: [input] });
    expect(result).toMatchObject({ code: 'MESH_BOOLEAN_FAILED', message: expect.stringContaining('WASM exploded') });
    expect(freed).toBeGreaterThanOrEqual(3);
  });

  it('reports a failing Manifold status, non-manifold operands per position and ops it does not answer', () => {
    const bad = manifoldMeshEngineOver(api(solidStub({ status: () => 'NotManifold' })));
    expect(bad.run(input, { op: 'minkowski', kind: 'sum', other: input })).toMatchObject({
      code: 'MESH_NON_MANIFOLD',
      message: expect.stringContaining('operand a'),
    });
    expect(bad.run(input, { op: 'boolean', kind: 'union', others: [input] })).toMatchObject({ code: 'MESH_NON_MANIFOLD' });
    expect(bad.run(input, { op: 'subdivide', method: 'smooth', levels: 1, featureAngleDeg: 30 })).toMatchObject({
      code: 'MESH_NON_MANIFOLD',
    });
    let calls = 0;
    const second = manifoldMeshEngineOver({
      Manifold: { ofMesh: () => solidStub({ status: () => (++calls === 1 ? 'NoError' : 'NotManifold') }) },
      Mesh: class {},
    });
    expect(second.run(input, { op: 'minkowski', kind: 'sum', other: input })).toMatchObject({
      message: expect.stringContaining('operand b'),
    });
    calls = 0;
    expect(second.run(input, { op: 'boolean', kind: 'union', others: [input] })).toMatchObject({
      message: expect.stringContaining('operand b'),
    });
    calls = 0;
    expect(second.run(input, { op: 'boolean', kind: 'union', others: [input, input] })).toMatchObject({
      message: expect.stringContaining('tool 1'),
    });
    const ok = manifoldMeshEngineOver(
      api(solidStub({ status: () => 'NoError', add: () => solidStub({ status: () => 'InvalidConstruction' }) })),
    );
    expect(ok.run(input, { op: 'boolean', kind: 'union', others: [input] })).toMatchObject({
      code: 'MESH_BOOLEAN_FAILED',
      message: expect.stringContaining('InvalidConstruction'),
    });
    expect(ok.run(input, { op: 'offset', method: 'normal', distance: 1, tolerance: 1, maxCells: 1 })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
    expect(ok.run(input, { op: 'subdivide', method: 'loop', levels: 1, featureAngleDeg: 30 })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
    expect(ok.run(input, { op: 'hull', points: [] })).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
    expect(ok.capabilities().has('wrap')).toBe(true);
  });

  it('refuses a hollow whose cavity vanishes and a grid it cannot resolve', () => {
    const empty = manifoldMeshEngineOver(api(solidStub({ isEmpty: () => true })));
    expect(empty.run(input, { op: 'hollow', wall: 0.2, tolerance: 0.5, maxCells: 1_000_000 })).toMatchObject({
      code: 'MESH_PARAM_INVALID',
    });
    expect(empty.run(input, { op: 'wrap', tolerance: 0.001, maxCells: 100 })).toMatchObject({ code: 'MESH_OFFSET_RESOLUTION' });
    const notClosed = manifoldMeshEngineOver({
      Manifold: { ofMesh: () => solidStub({ status: () => 'NotManifold' }), levelSet: () => solidStub() },
      Mesh: class {},
    });
    expect(notClosed.run(input, { op: 'hollow', wall: 0.2, tolerance: 0.5, maxCells: 1_000_000 })).toMatchObject({
      code: 'MESH_NON_MANIFOLD',
    });
  });
});

describe('level-set commands with the real engine on the edge cases', () => {
  it('a wall thicker than half the body leaves no cavity, and an offset that removes the body is refused, both unchanged', async () => {
    const { createManifoldMeshEngine } = await import('@kernel-manifold/manifoldMeshEngine');
    setMeshProcessingEngine(await createManifoldMeshEngine());
    try {
      const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]));
      const hollow = execute(doc, 'hollow_mesh', { id: ids[0], wallThickness: 6, tolerance: 0.5 });
      expectNoOp(hollow, doc);
      expect(hollow.error?.code).toBe('MESH_PARAM_INVALID');
      const gone = execute(doc, 'offset_mesh', { id: ids[0], distance: -6, tolerance: 0.5 });
      expectNoOp(gone, doc);
      expect(gone.error?.code).toBe('MESH_PARAM_INVALID');
      const tooBig = execute(doc, 'subdivide_mesh', { id: ids[0], method: 'smooth', maxEdgeLength: 0.001 });
      expectNoOp(tooBig, doc);
      expect(tooBig.error?.paths).toEqual(['maxEdgeLength']);
    } finally {
      setMeshProcessingEngine(null);
    }
  });
});
