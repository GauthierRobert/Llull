import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { base64ToUint8Array } from '@lib/base64';
import { zipStore } from '@lib/zip';
import { unzip } from '../helpers/unzipStore';

interface ThreeMfData {
  format: string;
  fileName: string;
  base64: string;
  objectCount: number;
  triangleCount: number;
  objects: Array<{ name: string; vertices: number; triangles: number; manifold: boolean }>;
}

const text = (files: Map<string, Uint8Array>, name: string): string => new TextDecoder().decode(files.get(name));

function exported(
  doc = createEmptyDocument(),
  params: Record<string, unknown> = {},
): { data: ThreeMfData; files: Map<string, Uint8Array> } {
  const result = execute(doc, 'export_3mf', params);
  const data = result.data as ThreeMfData;
  return { data, files: unzip(base64ToUint8Array(data.base64) ?? new Uint8Array()) };
}

describe('zipStore', () => {
  it('round-trips entries with CRC-32 and UTF-8 names', () => {
    const encoder = new TextEncoder();
    const files = unzip(
      zipStore([
        { name: 'a.txt', data: encoder.encode('hello') },
        { name: 'dir/é.bin', data: new Uint8Array([0, 1, 2, 255]) },
      ]),
    );
    expect([...files.keys()]).toEqual(['a.txt', 'dir/é.bin']);
    expect(text(files, 'a.txt')).toBe('hello');
    expect([...(files.get('dir/é.bin') ?? [])]).toEqual([0, 1, 2, 255]);
  });
});

describe('export_3mf', () => {
  const box = execute(createEmptyDocument(), 'add_box', { size: [10, 20, 30], color: '#ff0000', position: [5, 10, 15] });
  const named = execute(box.document, 'set_entity_name', { id: box.affected[0], name: 'Plate <A>' });
  const withCylinder = execute(named.document, 'add_cylinder', { radius: 4, height: 8, color: '#00ff00' });
  const doc = withCylinder.document;

  it('writes a 3MF package with the three required parts', () => {
    const { data, files } = exported(doc);
    expect(data.format).toBe('3mf');
    expect(data.fileName).toBe('model.3mf');
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect(text(files, '[Content_Types].xml')).toContain('application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
    expect(text(files, '_rels/.rels')).toContain('Target="/3D/3dmodel.model"');
  });

  it('has one named, coloured object per body with a build item each, in millimetres', () => {
    const { data, files } = exported(doc);
    const model = text(files, '3D/3dmodel.model');
    expect(model).toContain('unit="millimeter"');
    expect(data.objectCount).toBe(2);
    expect(data.objects.every((object) => object.manifold)).toBe(true);
    expect(model.match(/<object /g)).toHaveLength(2);
    expect(model.match(/<item /g)).toHaveLength(2);
    expect(model).toContain('name="Plate &lt;A&gt;"');
    expect(model).toContain('displaycolor="#FF0000"');
    expect(model).toContain('displaycolor="#00FF00"');
  });

  it('writes a welded, closed manifold mesh whose counts match data', () => {
    const { data, files } = exported(doc, { entityIds: [box.affected[0]] });
    const model = text(files, '3D/3dmodel.model');
    const vertices = [...model.matchAll(/<vertex x="([-\d.e]+)" y="([-\d.e]+)" z="([-\d.e]+)"\/>/g)].map((m) => m.slice(1).map(Number));
    const triangles = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].map((m) => m.slice(1).map(Number));
    expect(vertices).toHaveLength(8);
    expect(triangles).toHaveLength(12);
    expect(data.objects[0]).toEqual({ name: 'Plate <A>', vertices: 8, triangles: 12, manifold: true });
    const edges = new Map<string, number>();
    for (const [a, b, c] of triangles as [number, number, number][])
      for (const [from, to] of [
        [a, b],
        [b, c],
        [c, a],
      ] as const)
        edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) ?? 0) + 1);
    for (const [edge, count] of edges) {
      const [from, to] = edge.split('>');
      expect(count).toBe(1);
      expect(edges.get(`${to}>${from}`)).toBe(1);
    }
    const xs = vertices.map((v) => v[0] as number);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 10]);
  });

  it('converts document units to millimetres', () => {
    const metres = execute(createEmptyDocument(), 'set_units', { units: 'm' });
    const body = execute(metres.document, 'add_box', { size: [1, 1, 1] });
    const model = text(exported(body.document).files, '3D/3dmodel.model');
    expect(model).toContain('x="500"');
  });

  it('names the file after `name`', () => {
    expect(exported(doc, { name: 'my part/1' }).data.fileName).toBe('my_part_1.3mf');
  });

  it('is pure and read-only', () => {
    const before = JSON.stringify(doc);
    const result = execute(doc, 'export_3mf', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('is a no-op on a document without 3D bodies or with unknown ids', () => {
    const empty = execute(createEmptyDocument(), 'export_3mf', {});
    expect(empty.data).toBeUndefined();
    expect(empty.summary).toContain('no 3D body');
    const unknown = execute(doc, 'export_3mf', { entityIds: ['nope'] });
    expect(unknown.data).toBeUndefined();
    expect(unknown.affected).toEqual([]);
  });
});
