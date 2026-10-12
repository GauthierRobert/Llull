import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  type CadDocument,
  type Entity,
  type Material,
  FINISH_PATTERNS,
  createEmptyDocument,
} from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { encodePng } from '@core/lib/png';
import { hasGlyph, rasterizeText } from '@core/lib/blockFont';
import { boxUv, finishMaps } from '@core/geometry/finishMaps';
import { decalAxes, decalPatch } from '@core/geometry/decal';
import { expectNoOp } from '../helpers/expectNoOp';

const CARBON = {
  name: 'carbon',
  density: 0.0016,
  color: '#16181b',
  metalness: 0.2,
  roughness: 0.35,
  finish: 'carbon_twill',
  finishScale: 20,
  clearcoat: 1,
};

/** Decoded IHDR size and RGBA pixels of a PNG written by encodePng (filter 0 rows). */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, rgba };
}

function gltfOf(doc: CadDocument): Record<string, unknown> & {
  materials: Array<Record<string, unknown>>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; material: number }> }>;
  images?: unknown[];
  extensionsUsed?: string[];
} {
  return JSON.parse((execute(doc, 'export_gltf', {}).data as { text: string }).text);
}

describe('PNG encoder', () => {
  it('round-trips pixels through a standard inflate, including multi-block images', () => {
    const rgba = new Uint8Array(200 * 120 * 4).map((_, i) => (i * 37) % 256);
    const decoded = decodePng(encodePng(200, 120, rgba));
    expect(decoded.width).toBe(200);
    expect(decoded.height).toBe(120);
    expect(decoded.rgba).toEqual(rgba);
  });
});

describe('finish maps', () => {
  it.each(FINISH_PATTERNS)('%s builds tileable size² RGBA maps with unit normals', (pattern) => {
    const maps = finishMaps(
      { color: '#336699', metalness: 0.5, roughness: 0.4, finish: { pattern, scale: 10 } },
      32,
    );
    expect(maps).not.toBeNull();
    expect(maps?.albedo).toHaveLength(32 * 32 * 4);
    const n = maps?.normal ?? new Uint8Array();
    for (let p = 0; p < n.length; p += 4) {
      const v = [0, 1, 2].map((k) => ((n[p + k] ?? 0) - 127.5) / 127.5);
      expect(Math.hypot(...v)).toBeGreaterThan(0.97);
      expect(v[2]).toBeGreaterThan(0);
    }
    expect(maps?.metallicRoughness[2]).toBe(Math.round(0.5 * 255));
  });

  it('is null without a finish and tints alternate tows with color2', () => {
    expect(finishMaps({ color: '#000000', metalness: 0, roughness: 1 })).toBeNull();
    const checker = finishMaps(
      {
        color: '#000000',
        metalness: 0,
        roughness: 1,
        finish: { pattern: 'checker', scale: 1, color2: '#ffffff' },
      },
      16,
    );
    expect(checker?.albedo[0]).toBe(0);
    expect(checker?.albedo[(0 * 16 + 2) * 4]).toBe(255);
  });

  it('box UVs project on the plane of the dominant normal axis', () => {
    expect(boxUv([2, 4, 6], [0, 0, 1], 2)).toEqual([1, 2]);
    expect(boxUv([2, 4, 6], [0, 1, 0], 2)).toEqual([1, 3]);
    expect(boxUv([2, 4, 6], [1, 0, 0], 2)).toEqual([2, 3]);
  });
});

describe('create_material finish', () => {
  it('stores the finish and reports it', () => {
    const result = execute(createEmptyDocument(), 'create_material', CARBON);
    const material = result.document.materials['carbon'] as Material;
    expect(material.finish).toEqual({ pattern: 'carbon_twill', scale: 20, clearcoat: 1 });
    expect(result.summary).toContain('finish=carbon_twill every 20 mm');
  });

  it.each([
    ['scale', { finishScale: 0 }, 'finishScale must be > 0'],
    ['color2', { color2: 'red' }, 'color2 must be'],
    ['normal', { normalStrength: 3 }, 'normalStrength must be in [0, 2]'],
    ['clearcoat', { clearcoat: 2 }, 'clearcoat must be in [0, 1]'],
    ['option without a finish', { finish: undefined, clearcoat: 1 }, 'need a finish pattern'],
  ])('rejects a bad %s', (_label, patch, text) => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'create_material', { ...CARBON, ...patch }), doc, text);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    execute(doc, 'create_material', CARBON);
    expect(doc).toEqual(before);
  });

  it('round-trips and refuses corrupt saved finishes', () => {
    const doc = execute(createEmptyDocument(), 'create_material', {
      ...CARBON,
      color2: '#222222',
      normalStrength: 1.5,
    }).document;
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    }).document;
    expect(loaded.materials['carbon']).toEqual(doc.materials['carbon']);
    for (const finish of [
      { pattern: 'wood', scale: 1 },
      { pattern: 'checker', scale: -1 },
      { pattern: 'checker', scale: 1, color2: 'x' },
      { pattern: 'checker', scale: 1, clearcoat: 5 },
    ]) {
      const broken = {
        ...doc,
        materials: { carbon: { ...(doc.materials['carbon'] as Material), finish } as Material },
      };
      const result = execute(createEmptyDocument(), 'load_document', {
        json: serializeDocument(broken),
      });
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('finish');
    }
  });
});

describe('textured glTF export', () => {
  it('embeds albedo / normal / roughness PNGs, UVs and the clearcoat extension', () => {
    const doc = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'create_material', params: CARBON },
        { command: 'add_box', params: { size: [40, 20, 10] }, as: 'part' },
        { command: 'assign_material', params: { materialName: 'carbon', entityIds: ['$part'] } },
        { command: 'add_sphere', params: { radius: 5, position: [50, 0, 0] } },
      ],
    }).document;
    const gltf = gltfOf(doc);
    expect(gltf.images).toHaveLength(3);
    expect(gltf.extensionsUsed).toEqual(['KHR_materials_clearcoat']);
    const textured = gltf.materials[0] as Record<string, Record<string, unknown>>;
    expect(textured['pbrMetallicRoughness']?.['baseColorTexture']).toEqual({ index: 0 });
    expect(textured['normalTexture']).toEqual({ index: 2 });
    expect(gltf.meshes[0]?.primitives[0]?.attributes['TEXCOORD_0']).toBeDefined();
    expect(gltf.meshes[1]?.primitives[0]?.attributes['TEXCOORD_0']).toBeUndefined();
  });
});

describe('text decals', () => {
  const base = (): { doc: CadDocument; id: string } => {
    const result = execute(createEmptyDocument(), 'add_box', { size: [100, 40, 20] });
    return { doc: result.document, id: result.affected[0] as string };
  };
  const onTop = { text: 'Van Rysel', at: [0, 0, 10], normal: [0, 0, 1], height: 8 };

  it('paints a decal in the solid frame and exports it as a blended textured overlay', () => {
    const { doc, id } = base();
    const result = execute(doc, 'add_decal', { id, ...onTop, color: '#ff0000' });
    expect(result.affected).toEqual([id]);
    const decal = result.document.entities[id]?.decals?.[0];
    expect(decal?.text).toBe('Van Rysel');
    expect(decal?.width).toBeCloseTo(8 * rasterizeText('Van Rysel', '#fff').aspect, 9);
    const gltf = gltfOf(result.document);
    const overlay = gltf.materials.find((m) => m['alphaMode'] === 'BLEND');
    expect(overlay).toBeDefined();
    expect(gltf.meshes).toHaveLength(2);
    expect(gltf.meshes[1]?.primitives[0]?.attributes['TEXCOORD_0']).toBeDefined();
  });

  it('converts world placement into the frame of a moved and rotated solid', () => {
    const { doc, id } = base();
    const moved = execute(
      execute(doc, 'move_entity', { id, delta: [5, 0, 0] }).document,
      'rotate_entity',
      { id, delta: [0, 0, Math.PI / 2] },
    ).document;
    const result = execute(moved, 'add_decal', {
      id,
      text: 'L',
      at: [5, 50, 0],
      normal: [0, 1, 0],
      height: 5,
    });
    const decal = result.document.entities[id]?.decals?.[0];
    expect(decal?.center[0]).toBeCloseTo(50, 6);
    expect(decal?.normal[0]).toBeCloseTo(1, 6);
  });

  it('notes characters without a glyph and supports a background', () => {
    const { doc, id } = base();
    const result = execute(doc, 'add_decal', { id, ...onTop, text: 'A~B', background: '#000000' });
    expect(result.summary).toContain('print blank: ~');
    expect(hasGlyph('a')).toBe(true);
    const image = rasterizeText('AB', '#ffffff', '#000000');
    expect(image.width & (image.width - 1)).toBe(0);
    expect(image.rgba[3]).toBe(255);
  });

  it.each([
    ['missing entity', { id: 'nope' }, 'not found'],
    ['empty text', { text: '  ' }, 'text must be'],
    ['bad height', { height: 0 }, 'height must be > 0'],
    ['bad width', { width: -1 }, 'width must be > 0'],
    ['bad depth', { depth: 0 }, 'depth must be > 0'],
    ['bad background', { background: 'black' }, 'background must be'],
    ['zero normal', { normal: [0, 0, 0] }, 'normal must be non-zero'],
    ['misses the surface', { at: [0, 0, 500] }, 'does not reach any face'],
  ])('%s → no-op', (_label, patch, text) => {
    const { doc, id } = base();
    expectNoOp(execute(doc, 'add_decal', { id, ...onTop, ...patch }), doc, text);
  });

  it('add_decal and remove_decal are pure', () => {
    const { doc, id } = base();
    const before = structuredClone(doc);
    const painted = execute(doc, 'add_decal', { id, ...onTop }).document;
    expect(doc).toEqual(before);
    const decalId = painted.entities[id]?.decals?.[0]?.id as string;
    const paintedBefore = structuredClone(painted);
    execute(painted, 'remove_decal', { id, decalId });
    expect(painted).toEqual(paintedBefore);
  });

  it('refuses 2D targets, removes decals, scales them and validates saved ones', () => {
    const { doc, id } = base();
    const sketch = execute(doc, 'draw_circle', { center: [0, 0], radius: 1 });
    expectNoOp(
      execute(sketch.document, 'add_decal', { id: sketch.affected[0], ...onTop }),
      sketch.document,
      'not a solid',
    );
    const painted = execute(doc, 'add_decal', { id, ...onTop }).document;
    const decalId = painted.entities[id]?.decals?.[0]?.id as string;
    const scaled = execute(painted, 'scale_entity', { id, factor: 2 }).document;
    expect(scaled.entities[id]?.decals?.[0]?.height).toBe(16);
    const cleared = execute(painted, 'remove_decal', { id, decalId });
    expect(cleared.document.entities[id]).not.toHaveProperty('decals');
    expectNoOp(execute(painted, 'remove_decal', { id, decalId: 'x' }), painted, 'no decal');
    expectNoOp(execute(painted, 'remove_decal', { id: 'x', decalId }), painted, 'not found');
    const twice = execute(painted, 'add_decal', { id, ...onTop, at: [20, 0, 10] }).document;
    const one = execute(twice, 'remove_decal', { id, decalId });
    expect(one.document.entities[id]?.decals).toHaveLength(1);
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(painted),
    }).document;
    expect(loaded.entities[id]).toEqual(painted.entities[id]);
    for (const decals of [
      'x',
      [{ id: 'd' }],
      [{ ...painted.entities[id]?.decals?.[0], center: [0, 0] }],
      [{ ...painted.entities[id]?.decals?.[0], width: 0 }],
      [{ ...painted.entities[id]?.decals?.[0], color: 'red' }],
      [{ ...painted.entities[id]?.decals?.[0], text: ' ' }],
      [{ ...painted.entities[id]?.decals?.[0], normal: [0, 0, 0] }],
    ]) {
      const broken = {
        ...painted,
        entities: { [id]: { ...painted.entities[id], decals } as unknown as Entity },
      };
      const result = execute(createEmptyDocument(), 'load_document', {
        json: serializeDocument(broken),
      });
      expect(result.affected).toHaveLength(0);
    }
  });

  it('decal patches stay inside the decal box with UVs in [0, 1]', () => {
    const axes = decalAxes({ normal: [0, 0, 1], angle: Math.PI / 2 });
    expect(axes.x[1]).toBeCloseTo(1, 9);
    const patch = decalPatch(
      {
        id: 'd',
        text: 'X',
        center: [0, 0, 0],
        normal: [0, 0, 1],
        angle: 0,
        width: 2,
        height: 2,
        depth: 1,
        color: '#ffffff',
      },
      [
        [
          [-5, -5, 0],
          [5, -5, 0],
          [0, 5, 0],
        ],
        [
          [0, 0, 0],
          [0, 5, 0],
          [5, -5, 0],
        ],
      ],
    );
    expect(patch.positions.length).toBeGreaterThan(0);
    expect(patch.uvs.every((v) => v >= -1e-9 && v <= 1 + 1e-9)).toBe(true);
  });
});
