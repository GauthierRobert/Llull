/** RV1 RV-M1 / RV-M2 appearance commands: import_texture, set_material_appearance, apply_appearance, list_appearances, set_environment. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { TEXTURE_MEMORY_BUDGET_BYTES } from '@core/model/appearance';
import { APPEARANCE_LIBRARY } from '@core/model/appearanceLibrary';
import { sha256Hex } from '@lib/sha256';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { hdrBytes, jpegBytes, memoryImageAssets, pngBytes, toBase64 } from '../helpers/imageHeaderFixtures';

const store = (files: Record<string, Uint8Array> = {}): ReturnType<typeof memoryImageAssets> => memoryImageAssets(files, sha256Hex);
const withAssets = (assets: ReturnType<typeof memoryImageAssets> | null): ExecutionContext => ({
  ...defaultContext(),
  imageAssets: assets,
});

function textureDoc(): { doc: CadDocument; png: string; hdr: string } {
  let doc = createEmptyDocument();
  const png = execute(doc, 'import_texture', { name: 'albedo', base64: toBase64(pngBytes(64, 32)) }, withAssets(store()));
  doc = png.document;
  const hdr = execute(doc, 'import_texture', { name: 'sky', base64: toBase64(hdrBytes(128, 64)) }, withAssets(store()));
  return { doc: hdr.document, png: png.affected[0] as string, hdr: hdr.affected[0] as string };
}

function materialDoc(): CadDocument {
  return execute(createEmptyDocument(), 'create_material', { name: 'steel', density: 7850, densityUnit: 'kg/m^3', color: '#999999' })
    .document;
}

const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;

describe('import_texture', () => {
  it('records a PNG from base64 with its size, writes the bytes to the asset store and mints a step-scoped id', () => {
    const assets = store();
    const bytes = pngBytes(64, 32);
    const result = execute(createEmptyDocument(), 'import_texture', { name: 'albedo', base64: toBase64(bytes) }, withAssets(assets));
    const id = result.affected[0] as string;
    expect(id).toMatch(/^tex-/);
    const record = result.document.appearance?.textures[id];
    expect(record).toMatchObject({ name: 'albedo', format: 'png', width: 64, height: 32, bytes: bytes.length, colorSpace: 'srgb' });
    expect(record?.key).toBe(sha256Hex(bytes));
    expect(assets.files[record?.key as string]).toEqual(bytes);
    expect(result.document.appearance?.textureOrder).toEqual([id]);
  });

  it('reads a JPEG (any SOFn) and an HDR (always linear) by fileKey from the asset store', () => {
    const jpeg = jpegBytes(300, 200, 0xc2);
    const hdr = hdrBytes(2048, 1024);
    const assets = store({ [sha256Hex(jpeg)]: jpeg, [sha256Hex(hdr)]: hdr });
    const first = execute(
      createEmptyDocument(),
      'import_texture',
      { name: 'photo', fileKey: sha256Hex(jpeg), colorSpace: 'linear' },
      withAssets(assets),
    );
    expect(first.document.appearance?.textures[first.affected[0] as string]).toMatchObject({
      format: 'jpeg',
      width: 300,
      height: 200,
      colorSpace: 'linear',
    });
    const second = execute(first.document, 'import_texture', { name: 'env', fileKey: sha256Hex(hdr) }, withAssets(assets));
    expect(second.document.appearance?.textures[second.affected[0] as string]).toMatchObject({
      format: 'hdr',
      width: 2048,
      height: 1024,
      colorSpace: 'linear',
    });
    expect(second.document.appearance?.textureOrder).toHaveLength(2);
  });

  it('is pure', () => {
    const { doc } = textureDoc();
    expectPure(doc, () => execute(doc, 'import_texture', { name: 'another', base64: toBase64(pngBytes(8, 8)) }, withAssets(store())));
  });

  it('refuses a missing file: no port and an unknown key are TEXTURE_ASSET_UNAVAILABLE', () => {
    const doc = createEmptyDocument();
    const key = 'a'.repeat(64);
    const noPort = execute(doc, 'import_texture', { name: 't', fileKey: key }, withAssets(null));
    expectNoOp(noPort, doc, 'TEXTURE_ASSET_UNAVAILABLE');
    expect(codeOf(noPort)).toBe('TEXTURE_ASSET_UNAVAILABLE');
    const missing = execute(doc, 'import_texture', { name: 't', fileKey: key }, withAssets(store()));
    expectNoOp(missing, doc, 'TEXTURE_ASSET_UNAVAILABLE');
    expect(missing.rejected).toBe(true);
  });

  it('refuses an unsupported format (GIF, truncated PNG, HDR without a resolution line)', () => {
    const doc = createEmptyDocument();
    for (const bytes of [
      new TextEncoder().encode('GIF89a......................'),
      pngBytes(4, 4).subarray(0, 20),
      new TextEncoder().encode('#?RADIANCE\n\nno size\n'),
    ]) {
      const result = execute(doc, 'import_texture', { name: 't', base64: toBase64(bytes) }, withAssets(store()));
      expectNoOp(result, doc, 'TEXTURE_FORMAT_UNSUPPORTED');
      expect(codeOf(result)).toBe('TEXTURE_FORMAT_UNSUPPORTED');
    }
    const zero = execute(doc, 'import_texture', { name: 't', base64: toBase64(pngBytes(0, 5)) }, withAssets(store()));
    expectNoOp(zero, doc, 'TEXTURE_FORMAT_UNSUPPORTED');
  });

  it('refuses a side over 8192 px', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'import_texture', { name: 't', base64: toBase64(pngBytes(8193, 16)) }, withAssets(store()));
    expectNoOp(result, doc, 'TEXTURE_TOO_LARGE');
    expect(codeOf(result)).toBe('TEXTURE_TOO_LARGE');
    expect(execute(doc, 'import_texture', { name: 't', base64: toBase64(pngBytes(8192, 16)) }, withAssets(store())).affected).toHaveLength(
      1,
    );
  });

  it('refuses over the 1 GiB decoded budget and leaves the document unchanged', () => {
    let doc = createEmptyDocument();
    const big = toBase64(pngBytes(8192, 8192)); // 256 MiB decoded each
    for (let i = 0; i < 4; i++) {
      if (i < 3) doc = execute(doc, 'import_texture', { name: `big-${i}`, base64: big }, withAssets(store())).document;
    }
    const fourth = execute(doc, 'import_texture', { name: 'big-3', base64: big }, withAssets(store()));
    expect(fourth.affected).toHaveLength(1);
    doc = fourth.document;
    expect(Object.keys(doc.appearance?.textures ?? {})).toHaveLength(4);
    const fifth = execute(doc, 'import_texture', { name: 'one-more', base64: toBase64(pngBytes(2, 2)) }, withAssets(store()));
    expectNoOp(fifth, doc, 'TEXTURE_BUDGET_EXCEEDED');
    expect(codeOf(fifth)).toBe('TEXTURE_BUDGET_EXCEEDED');
    expect(TEXTURE_MEMORY_BUDGET_BYTES).toBe(4 * 8192 * 8192 * 4);
  });

  it('refuses a name collision, both / neither source, bad base64, hdr with srgb, and an oversized inline file', () => {
    const { doc } = textureDoc();
    const ctx = withAssets(store());
    expectNoOp(execute(doc, 'import_texture', { name: 'albedo', base64: toBase64(pngBytes(4, 4)) }, ctx), doc, 'TEXTURE_NAME_EXISTS');
    expectNoOp(execute(doc, 'import_texture', { name: 'x' }, ctx), doc, 'TEXTURE_PARAM_INVALID');
    expectNoOp(execute(doc, 'import_texture', { name: 'x', base64: 'AAAA', fileKey: 'b'.repeat(64) }, ctx), doc, 'TEXTURE_PARAM_INVALID');
    expectNoOp(execute(doc, 'import_texture', { name: 'x', base64: '!!!!' }, ctx), doc, 'TEXTURE_PARAM_INVALID');
    expectNoOp(execute(doc, 'import_texture', { name: ' ', base64: toBase64(pngBytes(4, 4)) }, ctx), doc, 'TEXTURE_PARAM_INVALID');
    expectNoOp(
      execute(doc, 'import_texture', { name: 'h', base64: toBase64(hdrBytes(4, 4)), colorSpace: 'srgb' }, ctx),
      doc,
      'TEXTURE_PARAM_INVALID',
    );
    const inline = new Uint8Array(9 * 1024 * 1024);
    inline.set(pngBytes(4, 4));
    expectNoOp(execute(doc, 'import_texture', { name: 'huge', base64: toBase64(inline) }, ctx), doc, 'TEXTURE_PARAM_INVALID');
  });

  it('refuses when the asset store cannot write the inline bytes', () => {
    const doc = createEmptyDocument();
    const failing = {
      readImage: () => null,
      writeImage: (): string => {
        throw new Error('disk full');
      },
    };
    expectNoOp(
      execute(doc, 'import_texture', { name: 't', base64: toBase64(pngBytes(4, 4)) }, { ...defaultContext(), imageAssets: failing }),
      doc,
      'TEXTURE_ASSET_UNAVAILABLE',
    );
  });
});

describe('set_material_appearance', () => {
  it('sets channels as values and textures and keeps colour, metalness and roughness in sync', () => {
    const { doc: withTextures, png } = textureDoc();
    const doc = { ...withTextures, materials: materialDoc().materials };
    const result = execute(doc, 'set_material_appearance', {
      material: 'steel',
      baseColor: { value: '#336699', texture: png },
      metalness: 1,
      roughness: { value: 0.3 },
      emission: '#ff0000',
      emissionStrength: 4,
      transmission: 0.2,
      ior: 1.45,
      coat: { value: 0.5 },
      coatRoughness: 0.1,
      uvScale: 250,
    });
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("set_material_appearance 'steel'");
    const material = result.document.materials['steel']!;
    expect(material).toMatchObject({ color: '#336699', metalness: 1, roughness: 0.3, density: doc.materials['steel']!.density });
    expect(material.appearance).toEqual({
      baseColor: { value: '#336699', texture: png },
      metalness: { value: 1 },
      roughness: { value: 0.3 },
      emission: { value: '#ff0000' },
      emissionStrength: 4,
      transmission: { value: 0.2 },
      ior: 1.45,
      coat: { value: 0.5 },
      coatRoughness: 0.1,
      uvScale: 250,
    });
  });

  it('merges: a later call replaces only the channels it names, clear removes channels and "all" the appearance', () => {
    const { doc: withTextures, png } = textureDoc();
    const doc = { ...withTextures, materials: materialDoc().materials };
    const first = execute(doc, 'set_material_appearance', { material: 'steel', roughness: 0.2, normal: { texture: png, normalScale: 2 } });
    const second = execute(first.document, 'set_material_appearance', { material: 'steel', metalness: 0.7 });
    expect(second.document.materials['steel']!.appearance).toEqual({
      roughness: { value: 0.2 },
      normal: { texture: png, normalScale: 2 },
      metalness: { value: 0.7 },
    });
    const cleared = execute(second.document, 'set_material_appearance', { material: 'steel', clear: ['normal', 'roughness'] });
    expect(cleared.document.materials['steel']!.appearance).toEqual({ metalness: { value: 0.7 } });
    const all = execute(cleared.document, 'set_material_appearance', { material: 'steel', clear: ['all'] });
    expect(all.document.materials['steel']!.appearance).toBeUndefined();
  });

  it('is pure', () => {
    const doc = materialDoc();
    expectPure(doc, () => execute(doc, 'set_material_appearance', { material: 'steel', roughness: 0.1 }));
  });

  it('refuses an unknown material, bad ranges, bad colour and an empty channel without changing the document', () => {
    const doc = materialDoc();
    const unknown = execute(doc, 'set_material_appearance', { material: 'nope', roughness: 0.1 });
    expectNoOp(unknown, doc, 'APPEARANCE_MATERIAL_NOT_FOUND');
    expect(codeOf(unknown)).toBe('APPEARANCE_MATERIAL_NOT_FOUND');
    for (const params of [
      { roughness: 1.5 },
      { metalness: { value: -0.1 } },
      { transmission: 2 },
      { ior: 0.5 },
      { ior: 3.5 },
      { emissionStrength: -1 },
      { coatRoughness: 2 },
      { uvScale: 0 },
      { baseColor: 'red' },
      { emission: { value: '#12' } },
      { roughness: {} },
      { baseColor: {} },
    ]) {
      const result = execute(doc, 'set_material_appearance', { material: 'steel', ...params });
      expectNoOp(result, doc, 'APPEARANCE_PARAM_INVALID');
    }
  });

  it('refuses a missing texture and an hdr texture on a surface channel', () => {
    const { doc: withTextures, hdr } = textureDoc();
    const doc = { ...withTextures, materials: materialDoc().materials };
    const missing = execute(doc, 'set_material_appearance', { material: 'steel', roughness: { texture: 'tex-ghost' } });
    expectNoOp(missing, doc, 'TEXTURE_NOT_FOUND');
    expect(codeOf(missing)).toBe('TEXTURE_NOT_FOUND');
    const wrongKind = execute(doc, 'set_material_appearance', { material: 'steel', baseColor: { texture: hdr } });
    expectNoOp(wrongKind, doc, 'TEXTURE_COLOR_SPACE');
    expectNoOp(execute(doc, 'set_material_appearance', { material: 'steel', normal: { texture: 'tex-ghost' } }), doc, 'TEXTURE_NOT_FOUND');
    expectNoOp(
      execute(doc, 'set_material_appearance', { material: 'steel', normal: { texture: 'tex-1', normalScale: 9 } }),
      doc,
      'APPEARANCE_PARAM_INVALID',
    );
  });
});

describe('apply_appearance', () => {
  it('ships steel, stainless, galvanised, painted, concrete, insulation cladding, glass, rubber, copper, brass with in-range values', () => {
    const ids = APPEARANCE_LIBRARY.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'steel',
        'stainless',
        'galvanised',
        'painted',
        'concrete',
        'insulation_cladding',
        'glass',
        'rubber',
        'copper',
        'brass',
      ]),
    );
    const glass = APPEARANCE_LIBRARY.find((entry) => entry.id === 'glass')!.appearance;
    expect(glass).toMatchObject({ transmission: { value: 1 }, ior: 1.5 });
    expect(glass.roughness?.value).toBeLessThan(0.1);
    for (const entry of APPEARANCE_LIBRARY) expect(entry.appearance.baseColor?.value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('applies to a material with a colour override and syncs the material values', () => {
    const doc = materialDoc();
    const result = execute(doc, 'apply_appearance', { appearance: 'painted', material: 'steel', color: '#1e5aa8' });
    const material = result.document.materials['steel']!;
    expect(material).toMatchObject({ color: '#1e5aa8', metalness: 0, roughness: 0.4 });
    expect(material.appearance).toMatchObject({ libraryId: 'painted', baseColor: { value: '#1e5aa8' }, coat: { value: 0.3 } });
    expect(result.affected).toEqual([]);
  });

  it('applies to entities as a visual override, keeping materialId, and skips lights, 2D shapes and unknown ids', () => {
    let doc = materialDoc();
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = execute(box.document, 'assign_material', { materialName: 'steel', entityIds: box.affected }).document;
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const lightId = 'light-1';
    const withLight: CadDocument = {
      ...line.document,
      entities: {
        ...line.document.entities,
        [lightId]: {
          id: lightId,
          kind: 'light',
          position: [0, 0, 3],
          rotation: [0, 0, 0],
          layerId: 'layer-default',
          color: '#ffffff',
          lightType: 'point',
          intensity: 100,
          lightColor: '#ffffff',
          radius: 0,
          castShadows: true,
        },
      },
      order: [...line.document.order, lightId],
    };
    const result = execute(withLight, 'apply_appearance', {
      appearance: 'glass',
      entityIds: [box.affected[0], line.affected[0], lightId, 'e-missing'],
    });
    expect(result.affected).toEqual(box.affected);
    const entity = result.document.entities[box.affected[0] as string]!;
    expect(entity.appearance).toMatchObject({ libraryId: 'glass', transmission: { value: 1 } });
    expect(entity.materialId).toBe('steel');
    expect(entity.color).toBe('#dff0f5');
    expect(result.document.entities[lightId]).toBe(withLight.entities[lightId]);
    expect(result.summary).toContain('Skipped');
  });

  it('is pure', () => {
    const doc = materialDoc();
    expectPure(doc, () => execute(doc, 'apply_appearance', { appearance: 'steel', material: 'steel' }));
  });

  it('refuses unknown ids, a bad colour, both or neither target, and only-invalid entities', () => {
    const doc = materialDoc();
    const unknown = execute(doc, 'apply_appearance', { appearance: 'unobtainium', material: 'steel' });
    expectNoOp(unknown, doc, 'APPEARANCE_NOT_FOUND');
    expect(codeOf(unknown)).toBe('APPEARANCE_NOT_FOUND');
    expectNoOp(
      execute(doc, 'apply_appearance', { appearance: 'painted', material: 'steel', color: 'blue' }),
      doc,
      'APPEARANCE_PARAM_INVALID',
    );
    expectNoOp(execute(doc, 'apply_appearance', { appearance: 'steel' }), doc, 'APPEARANCE_TARGET_INVALID');
    expectNoOp(
      execute(doc, 'apply_appearance', { appearance: 'steel', material: 'steel', entityIds: ['x'] }),
      doc,
      'APPEARANCE_TARGET_INVALID',
    );
    expectNoOp(execute(doc, 'apply_appearance', { appearance: 'steel', entityIds: [] }), doc, 'APPEARANCE_TARGET_INVALID');
    expectNoOp(execute(doc, 'apply_appearance', { appearance: 'steel', entityIds: ['e-missing'] }), doc, 'APPEARANCE_TARGET_INVALID');
    expectNoOp(execute(doc, 'apply_appearance', { appearance: 'steel', material: 'absent' }), doc, 'APPEARANCE_MATERIAL_NOT_FOUND');
  });
});

describe('list_appearances', () => {
  it('answers with the library, textures with sizes, memory, environment and who carries an appearance', () => {
    const { doc: withTextures } = textureDoc();
    let doc: CadDocument = { ...withTextures, materials: materialDoc().materials };
    doc = execute(doc, 'apply_appearance', { appearance: 'steel', material: 'steel' }).document;
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = execute(box.document, 'apply_appearance', { appearance: 'rubber', entityIds: box.affected }).document;
    doc = execute(doc, 'set_environment', { source: 'sky', turbidity: 3 }).document;
    const result = execute(doc, 'list_appearances', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as {
      library: { id: string }[];
      textures: { name: string; decodedBytes: number }[];
      textureMemory: { usedBytes: number; budgetBytes: number; maxDimension: number };
      environment: { source: string };
      materials: { name: string; libraryId: string }[];
      entities: { id: string; libraryId: string }[];
    };
    expect(data.library.length).toBeGreaterThanOrEqual(8);
    expect(data.textures.map((t) => [t.name, t.decodedBytes])).toEqual([
      ['albedo', 64 * 32 * 4],
      ['sky', 128 * 64 * 16],
    ]);
    expect(data.textureMemory).toEqual({
      usedBytes: 64 * 32 * 4 + 128 * 64 * 16,
      budgetBytes: TEXTURE_MEMORY_BUDGET_BYTES,
      maxDimension: 8192,
    });
    expect(data.environment.source).toBe('sky');
    expect(data.materials).toMatchObject([{ name: 'steel', libraryId: 'steel' }]);
    expect(data.entities).toMatchObject([{ id: box.affected[0], libraryId: 'rubber' }]);
    expect(result.summary).toContain('2 textures');
  });

  it('works on an empty document', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'list_appearances', {});
    expect(result.document).toBe(doc);
    expect((result.data as { environment: unknown }).environment).toBeNull();
  });
});

describe('set_environment', () => {
  it('sets sky, color and hdr environments and removes it with default', () => {
    const { doc, hdr } = textureDoc();
    const sky = execute(doc, 'set_environment', { source: 'sky', turbidity: 6, intensity: 2 });
    expect(sky.document.appearance?.environment).toEqual({ source: 'sky', turbidity: 6, intensity: 2 });
    expect(sky.document.appearance?.textureOrder).toEqual(doc.appearance?.textureOrder);
    const color = execute(sky.document, 'set_environment', { source: 'color', color: '#d8e6f2' });
    expect(color.document.appearance?.environment).toEqual({ source: 'color', color: '#d8e6f2', intensity: 1 });
    const map = execute(color.document, 'set_environment', { source: 'hdr', texture: hdr, rotation: 1.5, intensity: 0.5 });
    expect(map.document.appearance?.environment).toEqual({ source: 'hdr', texture: hdr, rotation: 1.5, intensity: 0.5 });
    const removed = execute(map.document, 'set_environment', { source: 'default' });
    expect(removed.document.appearance?.environment).toBeUndefined();
    expect(removed.document.appearance?.textures).toEqual(doc.appearance?.textures);
  });

  it('drops the whole slice when the default environment leaves nothing in it', () => {
    const color = execute(createEmptyDocument(), 'set_environment', { source: 'color', color: '#ffffff' });
    expect(color.document.appearance).toBeDefined();
    expect(execute(color.document, 'set_environment', { source: 'default' }).document.appearance).toBeUndefined();
  });

  it('is pure', () => {
    const { doc } = textureDoc();
    expectPure(doc, () => execute(doc, 'set_environment', { source: 'sky' }));
  });

  it('refuses out-of-range turbidity, non-finite numbers, missing / non-hdr / unknown textures and bad colours', () => {
    const { doc, png, hdr } = textureDoc();
    for (const params of [
      { source: 'sky', turbidity: 1 },
      { source: 'sky', turbidity: 11 },
      { source: 'sky', intensity: -1 },
      { source: 'color', color: 'white' },
      { source: 'color' },
      { source: 'hdr' },
      { source: 'hdr', texture: hdr, rotation: Number.POSITIVE_INFINITY },
    ]) {
      const result = execute(doc, 'set_environment', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
    expectNoOp(execute(doc, 'set_environment', { source: 'sky', turbidity: 11 }), doc, 'ENVIRONMENT_PARAM_INVALID');
    expectNoOp(execute(doc, 'set_environment', { source: 'hdr' }), doc, 'ENVIRONMENT_PARAM_INVALID');
    expectNoOp(execute(doc, 'set_environment', { source: 'hdr', texture: 'tex-ghost' }), doc, 'TEXTURE_NOT_FOUND');
    expectNoOp(execute(doc, 'set_environment', { source: 'hdr', texture: png }), doc, 'TEXTURE_FORMAT_UNSUPPORTED');
  });
});
