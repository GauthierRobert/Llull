/** RV1 RV-M1 review fixes: texture colour space per channel, clear_entity_appearance, remove_texture, load check of component entities. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { hdrBytes, memoryImageAssets, pngBytes, toBase64 } from '../helpers/imageHeaderFixtures';

const ctx = { ...defaultContext(), imageAssets: memoryImageAssets({}, sha256Hex) };

interface Fixture {
  readonly doc: CadDocument;
  readonly srgb: string;
  readonly linear: string;
  readonly hdr: string;
  readonly boxId: string;
}

function fixture(): Fixture {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  const add = (name: string, bytes: Uint8Array, colorSpace?: 'srgb' | 'linear'): void => {
    const result = execute(doc, 'import_texture', { name, base64: toBase64(bytes), ...(colorSpace ? { colorSpace } : {}) }, ctx);
    doc = result.document;
    ids.push(result.affected[0] as string);
  };
  add('albedo', pngBytes(8, 8), 'srgb');
  add('rough', pngBytes(9, 9), 'linear');
  add('sky', hdrBytes(16, 8));
  doc = execute(doc, 'create_material', { name: 'steel', density: 7850, densityUnit: 'kg/m^3' }).document;
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  return { doc: box.document, srgb: ids[0] as string, linear: ids[1] as string, hdr: ids[2] as string, boxId: box.affected[0] as string };
}

const withEntityAppearance = (doc: CadDocument, id: string, appearance: Entity['appearance']): Entity =>
  ({ ...(doc.entities[id] as Entity), appearance }) as Entity;

describe('texture colour space per channel', () => {
  it('accepts srgb for baseColor / emission and linear for data channels', () => {
    const { doc, srgb, linear } = fixture();
    const result = execute(doc, 'set_material_appearance', {
      material: 'steel',
      baseColor: { texture: srgb },
      emission: { texture: srgb },
      roughness: { texture: linear },
      metalness: { texture: linear },
      transmission: { texture: linear },
      coat: { texture: linear },
      normal: { texture: linear },
    });
    expect(result.error).toBeUndefined();
  });

  it.each(['baseColor', 'emission'])('refuses a linear texture on %s', (channel) => {
    const { doc, linear } = fixture();
    expectNoOp(execute(doc, 'set_material_appearance', { material: 'steel', [channel]: { texture: linear } }), doc, 'TEXTURE_COLOR_SPACE');
  });

  it.each(['roughness', 'metalness', 'transmission', 'coat'])('refuses an srgb texture on %s', (channel) => {
    const { doc, srgb } = fixture();
    expectNoOp(execute(doc, 'set_material_appearance', { material: 'steel', [channel]: { texture: srgb } }), doc, 'TEXTURE_COLOR_SPACE');
  });

  it('refuses an srgb normal map and an hdr texture on a surface channel', () => {
    const { doc, srgb, hdr } = fixture();
    expectNoOp(execute(doc, 'set_material_appearance', { material: 'steel', normal: { texture: srgb } }), doc, 'TEXTURE_COLOR_SPACE');
    expectNoOp(execute(doc, 'set_material_appearance', { material: 'steel', baseColor: { texture: hdr } }), doc, 'TEXTURE_COLOR_SPACE');
  });
});

describe('clear_entity_appearance', () => {
  it('removes the override and keeps colour and material', () => {
    const { doc, boxId } = fixture();
    const painted = execute(doc, 'apply_appearance', { appearance: 'painted', entityIds: [boxId], color: '#112233' }).document;
    expect(painted.entities[boxId]?.appearance).toBeDefined();
    const result = execute(painted, 'clear_entity_appearance', { entityIds: [boxId] });
    expect(result.affected).toEqual([boxId]);
    expect(result.document.entities[boxId]?.appearance).toBeUndefined();
    expect(result.document.entities[boxId]?.color).toBe('#112233');
    expect(result.document.order).toEqual(painted.order);
    expectPure(painted, () => execute(painted, 'clear_entity_appearance', { entityIds: [boxId] }));
  });

  it('refuses empty, unknown and override-less ids as no-ops', () => {
    const { doc, boxId } = fixture();
    expectNoOp(execute(doc, 'clear_entity_appearance', { entityIds: [] }), doc, 'APPEARANCE_TARGET_INVALID');
    expectNoOp(execute(doc, 'clear_entity_appearance', { entityIds: ['ghost'] }), doc, 'APPEARANCE_TARGET_INVALID');
    expectNoOp(execute(doc, 'clear_entity_appearance', { entityIds: [boxId] }), doc, 'APPEARANCE_NOT_SET');
  });
});

describe('remove_texture', () => {
  it('removes an unused texture, frees the order slot and is pure', () => {
    const { doc, srgb } = fixture();
    const result = execute(doc, 'remove_texture', { texture: srgb });
    expect(result.error).toBeUndefined();
    expect(result.document.appearance?.textures[srgb]).toBeUndefined();
    expect(result.document.appearance?.textureOrder).not.toContain(srgb);
    expect(result.document.appearance?.textureOrder).toHaveLength(2);
    expectPure(doc, () => execute(doc, 'remove_texture', { texture: srgb }));
  });

  it('refuses an unknown texture', () => {
    const { doc } = fixture();
    expectNoOp(execute(doc, 'remove_texture', { texture: 'tex-ghost' }), doc, 'TEXTURE_NOT_FOUND');
  });

  it('refuses while a material, an entity, a component entity or the environment references it', () => {
    const { doc, srgb, linear, hdr, boxId } = fixture();
    const byMaterial = execute(doc, 'set_material_appearance', { material: 'steel', baseColor: { texture: srgb } }).document;
    expectNoOp(execute(byMaterial, 'remove_texture', { texture: srgb }), byMaterial, 'TEXTURE_IN_USE');
    const byEnvironment = execute(doc, 'set_environment', { source: 'hdr', texture: hdr }).document;
    expectNoOp(execute(byEnvironment, 'remove_texture', { texture: hdr }), byEnvironment, 'TEXTURE_IN_USE');
    const entity = withEntityAppearance(doc, boxId, { roughness: { texture: linear } });
    const byEntity = { ...doc, entities: { ...doc.entities, [boxId]: entity } };
    expectNoOp(execute(byEntity, 'remove_texture', { texture: linear }), byEntity, 'TEXTURE_IN_USE');
    const byComponent: CadDocument = {
      ...doc,
      components: { 'comp-1': { id: 'comp-1', name: 'c', entities: { [boxId]: entity }, order: [boxId] } },
    };
    expectNoOp(execute(byComponent, 'remove_texture', { texture: linear }), byComponent, 'TEXTURE_IN_USE');
  });

  it('succeeds once the references are cleared', () => {
    const { doc, srgb, hdr } = fixture();
    const set = execute(doc, 'set_material_appearance', { material: 'steel', baseColor: { texture: srgb } }).document;
    const used = execute(set, 'set_environment', { source: 'hdr', texture: hdr }).document;
    const unset = execute(used, 'set_material_appearance', { material: 'steel', clear: ['baseColor'] }).document;
    const freed = execute(unset, 'set_environment', { source: 'default' }).document;
    expect(execute(freed, 'remove_texture', { texture: srgb }).error).toBeUndefined();
    expect(execute(freed, 'remove_texture', { texture: hdr }).error).toBeUndefined();
  });
});

describe('load validation of component entities', () => {
  it('refuses a component entity that references a missing texture', () => {
    const { doc, boxId } = fixture();
    const entity = withEntityAppearance(doc, boxId, { roughness: { texture: 'tex-ghost' } });
    const bad: CadDocument = {
      ...doc,
      components: { 'comp-1': { id: 'comp-1', name: 'c', entities: { [boxId]: entity }, order: [boxId] } },
    };
    expect(() => deserializeDocument(serializeDocument(bad))).toThrow(/component 'comp-1' entity .*unknown texture/);
  });
});

describe('import_texture inline limit', () => {
  it('refuses more than 1 MiB of inline bytes, pointing at fileKey / file=', () => {
    const doc = createEmptyDocument();
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(pngBytes(4, 4));
    const result = execute(doc, 'import_texture', { name: 'big', base64: toBase64(big) }, ctx);
    expectNoOp(result, doc, 'TEXTURE_PARAM_INVALID');
    expect(result.summary).toContain('file=PATH');
  });
});
