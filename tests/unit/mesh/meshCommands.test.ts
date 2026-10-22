/** 07 MSH M0 commands: import_mesh_file, analyze_mesh, check_mesh (happy, failure, purity, codes of TECHNICAL §7.1). */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sha256Hex } from '@lib/sha256';
import { uint8ArrayToBase64 } from '@lib/base64';
import { zipStore } from '@lib/zip';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes, icosphere, packFile, packJson, relativeError, soup } from '../../helpers/meshFixtures';

const stl = (name: string): string => uint8ArrayToBase64(new Uint8Array(packFile(name)));

interface Data {
  readonly [key: string]: unknown;
}

const dataOf = (result: { data?: unknown }): Data => result.data as Data;

function importFixture(name: string, extra: Record<string, unknown> = {}): ReturnType<typeof execute> {
  return execute(createEmptyDocument(), 'import_mesh_file', { base64: stl(name), units: 'mm', ...extra });
}

describe('import_mesh_file (VC-MSH-03, 27)', () => {
  it.each([
    ['icosphere_r10_l1_ascii.stl', 3658.71220851, 1166.59313917, 1e-9],
    ['icosphere_r10_l1_binary.stl', 3658.71216465, 1166.59312969, 1e-9],
  ])('%s -> 80 triangles, 42 welded vertices, closed, unverified, volume %s', (name, volume, area, tolerance) => {
    const result = importFixture(name);
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const data = dataOf(result);
    expect([data['triangles'], data['weldedVertices'], data['openEdges'], data['nonManifoldEdges'], data['shells']]).toEqual([
      80, 42, 0, 0, 1,
    ]);
    expect(relativeError(data['volume'] as number, volume)).toBeLessThan(tolerance);
    expect(relativeError(data['area'] as number, area)).toBeLessThan(tolerance);
    expect(data['unverified']).toBe(true);
    expect(data['sha256']).toBe(
      (packJson('stl_fixtures.json') as { files: Array<{ file: string; sha256: string }> }).files.find((f) => f.file === name)?.sha256,
    );
    expect(data['defaults']).toEqual([expect.objectContaining({ name: 'weldTolerance', defaulted: true })]);
    const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(entity.kind).toBe('mesh');
    expect(entity.meshSource).toMatchObject({ unitScale: 1, verified: false });
    expect(entity.mesh.indices).toHaveLength(240);
  });

  it('converts an inch file into the millimetre document once and reports the factor', () => {
    const result = importFixture('icosphere_r10_l1_binary.stl', { units: 'in' });
    expect(dataOf(result)['unitScale']).toBe(25.4);
    expect(relativeError(dataOf(result)['volume'] as number, 3658.71216465 * 16387.064)).toBeLessThan(1e-9);
  });

  it('marks the mesh verified when the pinned sha256 matches and refuses when it does not', () => {
    const sha = (packJson('stl_fixtures.json') as { files: Array<{ sha256: string }> }).files[1]?.sha256 as string;
    const verified = importFixture('icosphere_r10_l1_binary.stl', { sourceSha256: sha.toUpperCase(), fileName: 'ico.stl', name: 'scan' });
    expect(dataOf(verified)['unverified']).toBe(false);
    const entity = verified.document.entities[verified.affected[0] as string] as MeshSolidEntity;
    expect(entity.meshSource).toMatchObject({ verified: true, fileName: 'ico.stl', sourceSha256: sha });
    expect(entity.name).toBe('scan');
    const wrong = importFixture('icosphere_r10_l1_binary.stl', { sourceSha256: '00'.repeat(32) });
    expect(wrong.error?.code).toBe('MESH_IMPORT_SHA_MISMATCH');
    expect(wrong.affected).toHaveLength(0);
  });

  it('imports OBJ text with groups, a stated weld tolerance and colour; PLY and 3MF through the same path', () => {
    const obj = 'o part\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';
    const result = execute(createEmptyDocument(), 'import_mesh_file', {
      text: obj,
      units: 'cm',
      weldTolerance: 1e-3,
      color: '#ff0000',
      name: 'plate',
    });
    const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(entity.color).toBe('#ff0000');
    expect(entity.faceGroups).toEqual([{ id: 'part', faces: [[0, 2]] }]);
    expect(dataOf(result)['unitScale']).toBe(10);
    expect(dataOf(result)['defaults']).toEqual([]);
    expect(dataOf(result)['area']).toBeCloseTo(100, 9);
    const ply =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_index\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
    expect(execute(createEmptyDocument(), 'import_mesh_file', { text: ply, units: 'mm' }).affected).toHaveLength(1);
  });

  it('takes the 3MF unit from the file and needs no units', () => {
    const model =
      '<model unit="centimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
    const bytes = zipStore([{ name: '3D/3dmodel.model', data: new TextEncoder().encode(model) }]);
    const result = execute(createEmptyDocument(), 'import_mesh_file', { base64: uint8ArrayToBase64(bytes) });
    expect(result.error).toBeUndefined();
    expect(dataOf(result)['unitScale']).toBe(10);
    expect(dataOf(result)['format']).toBe('3mf');
    expect(dataOf(result)['area']).toBeCloseTo(50, 9);
  });

  it.each([
    [{ units: 'mm' }, 'MESH_PARAM_INVALID'],
    [{ base64: 'AAAA', text: 'x', units: 'mm' }, 'MESH_PARAM_INVALID'],
    [{ base64: '***', units: 'mm' }, 'MESH_PARAM_INVALID'],
    [
      { text: 'solid x\nfacet normal 0 0 1\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendfacet\nendsolid x\n' },
      'MESH_IMPORT_UNITS_REQUIRED',
    ],
    [{ text: 'hello', units: 'mm' }, 'MESH_IMPORT_FORMAT_UNKNOWN'],
    [{ text: 'solid x\nendsolid x\n', units: 'mm' }, 'MESH_IMPORT_EMPTY'],
    [{ text: 'v 0 0 0\nf 1 2 3\n', units: 'mm' }, 'MESH_IMPORT_PARSE'],
  ])('refuses %j with %s and leaves the document unchanged', (params, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'import_mesh_file', params);
    expectNoOp(result, doc);
    expect(result.error?.code).toBe(code);
    expect(result.error?.remediation).not.toBe('');
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => importFixture('icosphere_r10_l1_ascii.stl'));
  });
});

describe('analyze_mesh', () => {
  it('reports the ico sphere numbers with units, provenance and named defaults (read-only)', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const result = execute(doc, 'analyze_mesh', { id: ids[0] });
    expect(result.error).toBeUndefined();
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = dataOf(result);
    expect([
      data['faces'],
      data['vertices'],
      data['eulerCharacteristic'],
      data['genus'],
      data['closed'],
      data['selfIntersectionPairs'],
    ]).toEqual([320, 162, 2, 0, true, 0]);
    expect(relativeError(data['volume'] as number, 4047.04467998)).toBeLessThan(1e-9);
    expect(relativeError(data['area'] as number, 1232.98485952)).toBeLessThan(1e-9);
    expect(data).toMatchObject({ unit: 'mm', areaUnit: 'mm^2', volumeUnit: 'mm^3', unverified: true });
    expect(data['provenance']).toMatchObject({ engine: 'ts', algorithm: expect.any(String), reference: expect.any(String) });
    expect(data['defaults']).toEqual([expect.objectContaining({ name: 'weldTolerance', defaulted: true })]);
    expect(result.summary).toContain('closed');
  });

  it('analyses any 3D solid, honours weldTolerance / maxListed / selfIntersections false', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const id = doc.order[0] as string;
    const result = execute(doc, 'analyze_mesh', { id, weldTolerance: 1e-9, selfIntersections: false, maxListed: 1 });
    const data = dataOf(result);
    expect(data['volume']).toBeCloseTo(8, 9);
    expect(data['selfIntersectionPairs']).toBeNull();
    expect(data['defaults']).toEqual([]);
    expect(data['unverified']).toBe(false);
  });

  it('refuses unknown ids and 2D shapes with codes', () => {
    const { doc } = docWithMeshes(icosphere(1, 0));
    expectNoOp(execute(doc, 'analyze_mesh', { id: 'nope' }), doc);
    expect(execute(doc, 'analyze_mesh', { id: 'nope' }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    const drawn = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      closed: true,
    });
    const flat = execute(drawn.document, 'analyze_mesh', { id: drawn.affected[0] });
    expect(flat.error?.code).toBe('MESH_NOT_A_MESH');
    expect(flat.error?.ids).toEqual([drawn.affected[0]]);
  });

  it('is pure', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [1, 1, 1]));
    expectPure(doc, () => execute(doc, 'analyze_mesh', { id: ids[0] }));
  });
});

function defectDoc(): { doc: CadDocument; id: string } {
  const defect = packJson('defect_mesh.json') as { positions?: number[][]; faces?: number[][]; vertices?: number[][] };
  const positions = (defect.positions ?? defect.vertices ?? []).flat();
  const indices = (defect.faces ?? []).flat();
  const { doc, ids } = docWithMeshes({ positions, indices });
  return { doc, id: ids[0] as string };
}

describe('check_mesh (VC-MSH-28, 27)', () => {
  const codes = (result: { data?: unknown }): string[] => (dataOf(result)['findings'] as Array<{ code: string }>).map((f) => f.code);

  it('passes a clean icosphere for print and lists the two notes about the check', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const result = execute(doc, 'check_mesh', { ids, purpose: 'print' });
    expect(dataOf(result)['status']).toBe('pass');
    expect(codes(result).sort()).toEqual(['MESH_CHECK_INPUT_UNVERIFIED', 'MESH_CHECK_TOLERANCE_DEFAULTED']);
    expect(dataOf(result)['unverified']).toBe(true);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('PASS');
  });

  it('fails an open hemisphere with MESH_CHECK_NOT_CLOSED (print) but only warns for export', () => {
    const full = icosphere(10, 2);
    const keep: number[] = [];
    for (let f = 0; f < full.indices.length; f += 3) {
      const z = [0, 1, 2].reduce((s, k) => s + (full.positions[(full.indices[f + k] as number) * 3 + 2] as number), 0);
      if (z > 0) keep.push(...full.indices.slice(f, f + 3));
    }
    const { doc, ids } = docWithMeshes({ positions: full.positions, indices: keep });
    const printed = execute(doc, 'check_mesh', { ids, purpose: 'print' });
    expect(dataOf(printed)['status']).toBe('fail');
    expect(codes(printed)).toContain('MESH_CHECK_NOT_CLOSED');
    const finding = (dataOf(printed)['findings'] as Array<Record<string, unknown>>).find((f) => f['code'] === 'MESH_CHECK_NOT_CLOSED');
    expect(finding).toMatchObject({ severity: 'fail', ids, unit: 'edges' });
    expect(finding?.['where']).toHaveLength(3);
    expect(dataOf(execute(doc, 'check_mesh', { ids, purpose: 'export' }))['status']).toBe('warn');
  });

  it('fails a 0.4 mm slab with MESH_CHECK_WALL_THIN against 0.8 mm and passes against 0.3 mm', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 0.4]));
    const thin = execute(doc, 'check_mesh', { ids, purpose: 'print', minWallThickness: 0.8 });
    expect(dataOf(thin)['status']).toBe('fail');
    const finding = (dataOf(thin)['findings'] as Array<Record<string, unknown>>).find((f) => f['code'] === 'MESH_CHECK_WALL_THIN');
    expect(finding?.['value'] as number).toBeCloseTo(0.4, 9);
    expect(finding?.['limit']).toBe(0.8);
    expect(dataOf(thin)['tolerances']).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'minWallThickness', defaulted: false })]),
    );
    expect(dataOf(execute(doc, 'check_mesh', { ids, purpose: 'print', minWallThickness: 0.3 }))['status']).toBe('pass');
  });

  it('flags the defect mesh: degenerate faces, non-manifold edges and stray shells', () => {
    const { doc, id } = defectDoc();
    const result = execute(doc, 'check_mesh', { ids: [id], purpose: 'print', smallShellFaces: 4 });
    expect(dataOf(result)['status']).toBe('fail');
    expect(codes(result)).toEqual(expect.arrayContaining(['MESH_CHECK_NON_MANIFOLD', 'MESH_CHECK_DEGENERATE', 'MESH_CHECK_SMALL_SHELLS']));
  });

  it('flags inverted and inconsistently oriented shells, too many triangles and verifies a pinned source', () => {
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const inverted = {
      positions: box.positions,
      indices: box.indices.map((_, i) => box.indices[i - (i % 3) + ((3 - (i % 3)) % 3)] as number),
    };
    const { doc, ids } = docWithMeshes(inverted);
    expect(codes(execute(doc, 'check_mesh', { ids, purpose: 'fit' }))).toContain('MESH_CHECK_INVERTED');
    const mixed = { positions: box.positions, indices: [...box.indices] };
    [mixed.indices[1], mixed.indices[2]] = [mixed.indices[2] as number, mixed.indices[1] as number];
    const mixedDoc = docWithMeshes(mixed);
    expect(codes(execute(mixedDoc.doc, 'check_mesh', { ids: mixedDoc.ids, purpose: 'boolean' }))).toContain(
      'MESH_CHECK_INCONSISTENT_ORIENTATION',
    );
    const boxDoc = docWithMeshes(box);
    const many = execute(boxDoc.doc, 'check_mesh', { ids: boxDoc.ids, purpose: 'export', maxTriangles: 5 });
    expect(dataOf(many)['status']).toBe('fail');
    expect(codes(many)).toContain('MESH_CHECK_TRIANGLES_ABOVE_LIMIT');
    const imported = importFixture('icosphere_r10_l1_ascii.stl', { sourceSha256: sha256Hex(packFile('icosphere_r10_l1_ascii.stl')) });
    const verified = execute(imported.document, 'check_mesh', { ids: imported.affected, purpose: 'print', weldTolerance: 1e-6 });
    expect(codes(verified)).toEqual([]);
    expect(dataOf(verified)['unverified']).toBe(false);
  });

  it('reports crossing triangles of overlapping bodies as MESH_CHECK_SELF_OVERLAP', () => {
    const a = cuboid([0, 0, 0], [2, 2, 2]);
    const b = cuboid([0.9, 1.1, 0.7], [2.9, 3.1, 2.7]);
    const { doc, ids } = docWithMeshes({
      positions: [...a.positions, ...b.positions],
      indices: [...a.indices, ...b.indices.map((i) => i + 8)],
    });
    expect(codes(execute(doc, 'check_mesh', { ids, purpose: 'print' }))).toContain('MESH_CHECK_SELF_OVERLAP');
  });

  it('refuses unknown ids and is pure', () => {
    const { doc, ids } = docWithMeshes(soupCube());
    expectNoOp(execute(doc, 'check_mesh', { ids: [ids[0], 'ghost'], purpose: 'print' }), doc);
    expect(execute(doc, 'check_mesh', { ids: ['ghost'], purpose: 'print' }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'check_mesh', { ids, purpose: 'print' }));
  });
});

function soupCube(): { positions: number[]; indices: number[] } {
  const box = cuboid([0, 0, 0], [1, 1, 1]);
  return { positions: soup(box), indices: Array.from({ length: 36 }, (_, i) => i) };
}
