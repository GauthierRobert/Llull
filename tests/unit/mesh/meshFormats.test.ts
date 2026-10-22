/** 07 MSH M0: STL / OBJ / PLY / 3MF readers (VC-MSH-03 fixtures, generated OBJ / PLY / 3MF, malformed input). */

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '@lib/crc32';
import { deflateRaw } from '@lib/deflate';
import { inflateRaw } from '@lib/inflate';
import { sha256Hex } from '@lib/sha256';
import { zipStore } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import { parseMeshFile, sniffMeshFormat } from '@lib/meshFormats';
import { isParseFailure, type MeshParseFailure, type ParsedMeshFile } from '@lib/meshFormats/types';
import { weldMesh } from '@core/geometry/mesh/weld';
import { analyzeIndexedMesh } from '@core/geometry/mesh/analysis';
import { packFile, packJson, relativeError } from '../../helpers/meshFixtures';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function parsed(bytes: Uint8Array, kind?: 'stl' | 'obj' | 'ply' | '3mf'): ParsedMeshFile {
  const result = parseMeshFile(bytes, kind);
  if (isParseFailure(result)) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

const failureOf = (bytes: Uint8Array, kind?: 'stl' | 'obj' | 'ply' | '3mf'): MeshParseFailure | null => {
  const result = parseMeshFile(bytes, kind);
  return isParseFailure(result) ? result : null;
};

function volumeOf(file: ParsedMeshFile): { vertices: number; triangles: number; volume: number; area: number } {
  const body = file.bodies[0];
  const welded = weldMesh({ positions: body?.positions ?? [], indices: body?.triangles ?? [] }, 1e-6 * 20);
  const analysis = analyzeIndexedMesh(welded.positions, welded.triangles, { selfIntersections: false, maxListed: 0 });
  return { vertices: analysis.vertices, triangles: analysis.faces, volume: analysis.volume as number, area: analysis.area };
}

describe('STL fixtures of the pack (VC-MSH-03)', () => {
  const fixtures = (
    packJson('stl_fixtures.json') as {
      files: Array<{
        file: string;
        sha256: string;
        bytes: number;
        triangles: number;
        weldedVertices: number;
        expectedVolume: number;
        expectedArea: number;
      }>;
    }
  ).files;

  it.each(fixtures)('$file: pinned sha256, 80 triangles, 42 welded vertices, volume and area', (fixture) => {
    const bytes = packFile(fixture.file);
    expect(bytes.length).toBe(fixture.bytes);
    expect(sha256Hex(bytes)).toBe(fixture.sha256);
    const file = parsed(bytes);
    expect(file.format).toBe(fixture.file.includes('binary') ? 'stl-binary' : 'stl-ascii');
    const measured = volumeOf(file);
    expect([measured.triangles, measured.vertices]).toEqual([fixture.triangles, fixture.weldedVertices]);
    expect(relativeError(measured.volume, fixture.expectedVolume)).toBeLessThan(1e-9);
    expect(relativeError(measured.area, fixture.expectedArea)).toBeLessThan(1e-9);
  });

  it('treats a binary file whose header starts with "solid" as binary when the size rule holds', () => {
    const bytes = new Uint8Array(packFile('icosphere_r10_l1_binary.stl'));
    bytes.set(text('solid fake header'), 0);
    expect(parsed(bytes).format).toBe('stl-binary');
    expect(sniffMeshFormat(bytes)).toBe('stl');
  });

  it('reads several solid blocks as several named bodies', () => {
    const one = 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';
    const file = parsed(text(`solid first\n${one}endsolid first\nsolid second\n${one}endsolid second\n`));
    expect(file.bodies.map((b) => b.name)).toEqual(['first', 'second']);
  });
});

describe('OBJ', () => {
  it('fan-triangulates polygons, resolves negative indices, keeps groups and reports dropped attributes', () => {
    const file = parsed(
      text(
        '# c\nmtllib a.mtl\no quad\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nusemtl m\nf 1/1/1 2/1/1 3/1/1 4/1/1\ng tri\nf -4 -3 -2\n',
      ),
    );
    const body = file.bodies[0];
    expect(body?.triangles).toHaveLength(9);
    expect(body?.triangles.slice(6)).toEqual([0, 1, 2]);
    expect(body?.groups).toEqual([
      { name: 'quad', start: 0, end: 2 },
      { name: 'tri', start: 2, end: 3 },
    ]);
    expect(file.dropped.sort()).toEqual(['material libraries: 1', 'material references: 1', 'normals: 1', 'texture coordinates: 1']);
    expect(file.unitMetres).toBeUndefined();
  });

  it('refuses out-of-range indices, short faces and bad vertices with the line number', () => {
    expect(failureOf(text('v 0 0 0\nv 1 0 0\nf 1 2 9\n'), 'obj')?.message).toContain('line 3');
    expect(failureOf(text('v 0 0 0\nv 1 0 0\nf 1 2\n'), 'obj')?.code).toBe('MESH_IMPORT_PARSE');
    expect(failureOf(text('v 0 x 0\n'), 'obj')?.message).toContain('line 1');
  });
});

describe('PLY', () => {
  const header = (format: string, extra = ''): string =>
    `ply\nformat ${format} 1.0\ncomment c\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n${extra}element face 1\nproperty list uchar int vertex_indices\nend_header\n`;

  it('reads ascii with a quad face and drops extra properties', () => {
    const file = parsed(
      text(
        `${header('ascii', 'property uchar red\n').replace('property float z\n', 'property float z\n')}0 0 0 255\n1 0 0 255\n1 1 0 255\n0 1 0 255\n4 0 1 2 3\n`,
      ),
    );
    expect(file.bodies[0]?.triangles).toEqual([0, 1, 2, 0, 2, 3]);
    expect(file.dropped).toEqual(['vertex.red']);
  });

  it.each([true, false])('reads binary (little endian: %s)', (little) => {
    const head = text(header(little ? 'binary_little_endian' : 'binary_big_endian'));
    const body = new DataView(new ArrayBuffer(48 + 1 + 16));
    [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0].forEach((value, i) => body.setFloat32(i * 4, value, little));
    body.setUint8(48, 4);
    [0, 1, 2, 3].forEach((value, i) => body.setInt32(49 + i * 4, value, little));
    const bytes = new Uint8Array(head.length + body.byteLength);
    bytes.set(head, 0);
    bytes.set(new Uint8Array(body.buffer), head.length);
    const file = parsed(bytes);
    expect(file.bodies[0]?.positions.slice(3, 6)).toEqual([2, 0, 0]);
    expect(file.bodies[0]?.triangles).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('refuses a missing end_header, unknown formats, truncated bodies and bad indices', () => {
    expect(failureOf(text('ply\nformat ascii 1.0\n'), 'ply')?.message).toContain('end_header');
    expect(failureOf(text(header('weird')), 'ply')?.message).toContain('weird');
    expect(failureOf(text(header('binary_little_endian')), 'ply')?.message).toContain('unexpected end');
    expect(failureOf(text(`${header('ascii')}0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 9\n`), 'ply')?.message).toContain('outside');
    expect(failureOf(text('plx'), 'ply')?.code).toBe('MESH_IMPORT_PARSE');
  });
});

/** A ZIP with one DEFLATE entry (method 8), to exercise the inflate path. */
function deflatedZip(name: string, content: string): Uint8Array {
  const data = text(content);
  const packed = deflateRaw(data);
  const nameBytes = text(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(8, 8, true);
  local.setUint32(14, crc32(data), true);
  local.setUint32(18, packed.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(10, 8, true);
  central.setUint32(16, crc32(data), true);
  central.setUint32(20, packed.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, nameBytes.length, true);
  const localPart = [new Uint8Array(local.buffer), nameBytes, packed];
  const localSize = localPart.reduce((n, part) => n + part.length, 0);
  const centralSize = 46 + nameBytes.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, localSize, true);
  const parts = [...localPart, new Uint8Array(central.buffer), nameBytes, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((offset, part) => (out.set(part, offset), offset + part.length), 0);
  return out;
}

const MODEL = (unit: string, items: string): string =>
  `<?xml version="1.0"?><model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>` +
  '<object id="1" name="tetra" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices>' +
  '<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object>' +
  '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>' +
  `</resources><build>${items}</build></model>`;

describe('3MF and the ZIP / DEFLATE readers', () => {
  it('inflates what deflateRaw wrote and unzips stored and deflated entries', () => {
    const payload = text('abcabcabc'.repeat(200) + 'tail');
    expect(Array.from(inflateRaw(deflateRaw(payload)))).toEqual(Array.from(payload));
    const stored = unzip(zipStore([{ name: 'a/b.txt', data: text('hello') }]));
    expect(stored.map((e) => [e.name, new TextDecoder().decode(e.data)])).toEqual([['a/b.txt', 'hello']]);
    expect(new TextDecoder().decode(unzip(deflatedZip('x.txt', 'deflated '.repeat(50)))[0]?.data)).toBe('deflated '.repeat(50));
  });

  it('inflates dynamic-Huffman and stored blocks written by zlib', () => {
    const prose = Array.from({ length: 4000 }, (_, i) => `vertex ${(i * 7919) % 1013} ${Math.sin(i).toFixed(6)} ${i % 17}`).join('\n');
    const data = text(prose);
    expect(Array.from(inflateRaw(deflateRawSync(data, { level: 9 })))).toEqual(Array.from(data));
    expect(Array.from(inflateRaw(deflateRawSync(data, { level: 0 })))).toEqual(Array.from(data));
    expect(() => inflateRaw(deflateRawSync(data), 100)).toThrow('size limit');
  });

  it('reads objects, components and build transforms with the file unit (stored and deflated)', () => {
    const model = MODEL('inch', '<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 5 0"/>');
    for (const bytes of [zipStore([{ name: '3D/3dmodel.model', data: text(model) }]), deflatedZip('3D/3dmodel.model', model)]) {
      const file = parsed(bytes);
      expect(file.format).toBe('3mf');
      expect(file.unitMetres).toBe(0.0254);
      expect(file.bodies).toHaveLength(2);
      expect(file.bodies[0]?.name).toBe('tetra');
      expect(file.bodies[1]?.positions.slice(0, 3)).toEqual([10, 5, 0]);
      expect(sniffMeshFormat(bytes)).toBe('3mf');
    }
  });

  it('without a build section every object with a mesh becomes a body', () => {
    const bytes = zipStore([{ name: '3D/3dmodel.model', data: text(MODEL('millimeter', '')) }]);
    expect(parsed(bytes).bodies).toHaveLength(2);
  });

  it('refuses a non-zip, a zip without a model, an unknown unit and bad indices', () => {
    expect(failureOf(new Uint8Array([0x50, 0x4b, 1, 2, 3]), '3mf')?.code).toBe('MESH_IMPORT_PARSE');
    expect(failureOf(zipStore([{ name: 'a.txt', data: text('x') }]), '3mf')?.message).toContain('3dmodel.model');
    expect(failureOf(zipStore([{ name: '3D/3dmodel.model', data: text(MODEL('parsec', '')) }]), '3mf')?.message).toContain('parsec');
    const broken = MODEL('millimeter', '').replace('v3="1"', 'v3="99"');
    expect(failureOf(zipStore([{ name: '3D/3dmodel.model', data: text(broken) }]), '3mf')?.message).toContain('outside');
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff]))).toThrow();
  });
});

describe('sniffing and empty input', () => {
  it('reports unknown formats and empty files with their codes', () => {
    expect(failureOf(text('hello world'))?.code).toBe('MESH_IMPORT_FORMAT_UNKNOWN');
    expect(failureOf(text('v 0 0 0\n'), 'obj')?.code).toBe('MESH_IMPORT_EMPTY');
    expect(failureOf(text('solid x\nendsolid x\n'))?.code).toBe('MESH_IMPORT_EMPTY');
    expect(sniffMeshFormat(text('v 1 2 3\nf 1 1 1'))).toBe('obj');
    expect(sniffMeshFormat(text('ply\n'))).toBe('ply');
  });

  it('refuses malformed ascii STL facets and non-finite binary coordinates', () => {
    expect(failureOf(text('solid x\nfacet normal 0 0 1\nvertex 0 0 0\nvertex 1 0 0\nendfacet\nendsolid\n'))?.message).toContain(
      'expected 3',
    );
    expect(failureOf(text('solid x\nfacet normal 0 0 1\nvertex 0 zero 0\n'))?.message).toContain('line 3');
    const binary = new Uint8Array(84 + 50);
    new DataView(binary.buffer).setUint32(80, 1, true);
    new DataView(binary.buffer).setFloat32(96, Number.NaN, true);
    expect(failureOf(binary)?.code).toBe('MESH_IMPORT_PARSE');
  });
});
