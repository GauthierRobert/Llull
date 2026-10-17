import { describe, expect, it } from 'vitest';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { deflateRaw } from '@lib/deflate';
import { encodePng } from '@lib/png';
import { splitForDepth } from '@core/commands/render/depthSplit';
import type { PreDepthPolygon } from '@core/commands/render/types';

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => execute(doc, name, params).document;

/** RGBA pixels of a PNG written by encodePng (filters None / Up only). */
function decodePng(png: Buffer): { width: number; height: number; pixel: (x: number, y: number) => number[] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      pixels[y * stride + x] = filter === 2 && y > 0 ? (value + (pixels[(y - 1) * stride + x] ?? 0)) & 0xff : value;
    }
  }
  return { width, height, pixel: (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

const pngOf = (svg: string): Buffer => {
  const match = /href="data:image\/png;base64,([^"]+)"/.exec(svg);
  expect(match).not.toBeNull();
  return Buffer.from(match?.[1] ?? '', 'base64');
};

describe('render_view raster mode (default)', () => {
  it('depth-buffers solids: a near box hides a far one whatever their draw order', () => {
    let doc = createEmptyDocument();
    doc = run(doc, 'add_box', { size: [10, 2, 10], position: [0, 0, 0], color: '#ff0000' });
    doc = run(doc, 'add_box', { size: [20, 2, 20], position: [0, 20, 0], color: '#0000ff' });
    const before = JSON.stringify(doc);
    const result = execute(doc, 'render_view', { view: 'front', showGrid: false, showAxes: false, width: 200, height: 200 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toEqual([]);
    const svg = (result.data as { svg: string }).svg;
    expect(svg).not.toContain('<polygon');
    const image = decodePng(pngOf(svg));
    expect([image.width, image.height]).toEqual([200, 200]);
    const [r, g, b, a] = image.pixel(100, 100);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(80);
    expect(b).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    const [, , blueEdge] = image.pixel(60, 100);
    expect(blueEdge).toBeGreaterThan(80);
    expect(image.pixel(2, 2)[3]).toBe(0);
  });

  it('paints a solid in its assigned material colour, as the viewport does', () => {
    let doc = createEmptyDocument();
    const added = execute(doc, 'add_box', { size: [10, 10, 10], color: '#0000ff' });
    doc = run(added.document, 'create_material', { name: 'red', density: 0.001, color: '#ff0000' });
    doc = run(doc, 'assign_material', { materialName: 'red', entityIds: [added.affected[0]] });
    const svg = (execute(doc, 'render_view', { view: 'front', showGrid: false, width: 100, height: 100 }).data as { svg: string }).svg;
    const [r, , b] = decodePng(pngOf(svg)).pixel(50, 50);
    expect(r).toBeGreaterThan(80);
    expect(b).toBe(0);
  });

  it('fills section caps and keeps strokes as vector paths', () => {
    let doc = createEmptyDocument();
    doc = run(doc, 'add_box', { size: [10, 10, 10] });
    doc = run(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [30, 0],
      ],
    });
    const cut = { planes: [{ normal: [1, 0, 0] as Vec3, offset: 0 }] };
    const svg = (execute(doc, 'render_view', { cut }).data as { svg: string }).svg;
    expect(svg).toContain('<polyline');
    expect(pngOf(svg).length).toBeGreaterThan(100);
  });
});

describe('deflate + png', () => {
  it('round-trips through zlib and compresses flat images', () => {
    const data = new Uint8Array(70000).map((_, i) => (i % 900 < 450 ? 7 : (i * 31) % 251));
    expect(Buffer.from(inflateRawSync(Buffer.from(deflateRaw(data)))).equals(Buffer.from(data))).toBe(true);
    expect(deflateRaw(new Uint8Array(0)).length).toBeGreaterThan(0);
    const rgba = new Uint8Array(300 * 200 * 4).map((_, i) => (Math.floor(i / 4) % 300 < 150 ? 200 : 30));
    const packed = encodePng(300, 200, rgba, true);
    expect(packed.length).toBeLessThan(encodePng(300, 200, rgba).length / 20);
    const image = decodePng(Buffer.from(packed));
    expect(image.pixel(10, 150)).toEqual([200, 200, 200, 200]);
    expect(image.pixel(290, 199)).toEqual([30, 30, 30, 30]);
  });
});

describe('splitForDepth (vector mode)', () => {
  const face = (owner: string, z: number, size: number): PreDepthPolygon => ({
    verts: [
      [0, 0, z],
      [size, 0, z],
      [size, size, z],
      [0, size, z],
    ],
    color: '#808080',
    normal: [0, 0, 1],
    stroke: false,
    owner,
  });
  const top = (p: Vec3): readonly [number, number] => [p[0], p[1]];

  it('splits large faces only where another entity overlaps them on screen, within the budget', () => {
    const lone = splitForDepth([face('a', 0, 10)], 2, 1000, top);
    expect(lone).toHaveLength(1);
    const pair = splitForDepth([face('a', 0, 10), face('b', 1, 1)], 2, 1000, top);
    expect(pair.length).toBeGreaterThan(10);
    expect(pair.filter((p) => p.seamless === true).length).toBe(pair.length - 1);
    const area = pair
      .filter((p) => p.owner === 'a')
      .reduce((sum, p) => {
        const [a, b, c] = p.verts as [Vec3, Vec3, Vec3];
        return sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }, 0);
    expect(area).toBeCloseTo(100, 9);
    expect(splitForDepth([face('a', 0, 10), face('b', 1, 1)], 2, 0, top)).toHaveLength(2);
    expect(splitForDepth([face('a', 0, 10), face('b', 1, 1)], 0, 10, top)).toHaveLength(2);
  });
});
