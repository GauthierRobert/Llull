/** RV1 RV-M1: the appearance slice, material / entity appearances and mesh uvs / normals survive a save and are validated on load. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { memoryImageAssets, pngBytes, hdrBytes, toBase64 } from '../helpers/imageHeaderFixtures';
import { sha256Hex } from '@lib/sha256';

function build(): { doc: CadDocument; meshId: string; texture: string } {
  const ctx = { ...defaultContext(), imageAssets: memoryImageAssets({}, sha256Hex) };
  let doc = createEmptyDocument();
  const tex = execute(doc, 'import_texture', { name: 'albedo', base64: toBase64(pngBytes(16, 16)) }, ctx);
  doc = execute(tex.document, 'import_texture', { name: 'sky', base64: toBase64(hdrBytes(32, 16)) }, ctx).document;
  const texture = tex.affected[0] as string;
  doc = execute(doc, 'create_material', { name: 'steel', density: 7850, densityUnit: 'kg/m^3' }).document;
  doc = execute(doc, 'set_material_appearance', { material: 'steel', baseColor: { texture }, roughness: 0.3 }).document;
  doc = execute(doc, 'set_environment', { source: 'hdr', texture: doc.appearance?.textureOrder[1] as string, rotation: 0.5 }).document;
  const imported = execute(
    doc,
    'import_mesh_file',
    { text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', format: 'obj', units: 'mm' },
    { ...defaultContext(), meshAssets: null },
  );
  const meshId = imported.affected[0] as string;
  const entity = imported.document.entities[meshId] as Entity & { mesh: { positions: number[]; indices: number[] } };
  const mesh = { ...entity.mesh, uvs: [0, 0, 1, 0, 0, 1], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
  doc = {
    ...imported.document,
    entities: { ...imported.document.entities, [meshId]: { ...entity, mesh, appearance: { roughness: { value: 0.1 } } } as Entity },
  };
  return { doc, meshId, texture };
}

const loadError = (value: unknown): string => {
  try {
    deserializeDocument(JSON.stringify({ format: 'llull-document', version: 3, document: value }));
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

type Json = { [key: string]: unknown };

/** The saved form of `doc` with `change` applied to a deep copy (the copy is plain JSON, so any field can be damaged). */
const edit = (doc: CadDocument, change: (raw: Json) => void): unknown => {
  const raw = JSON.parse(JSON.stringify(doc)) as Json;
  change(raw);
  return raw;
};

/** `raw[path[0]][path[1]]... = value`. */
function put(raw: Json, path: readonly string[], value: unknown): void {
  let node = raw;
  for (const key of path.slice(0, -1)) node = node[key] as Json;
  node[path[path.length - 1] as string] = value;
}

describe('appearance persistence', () => {
  it('round-trips the slice, a material appearance, an entity appearance and mesh uvs / normals', () => {
    const { doc, meshId } = build();
    expect(doc.entities[meshId]?.appearance).toBeDefined();
    const text = serializeDocument(doc);
    const loaded = deserializeDocument(text);
    expect(loaded.appearance).toEqual(doc.appearance);
    expect(loaded.materials['steel']?.appearance).toEqual(doc.materials['steel']?.appearance);
    expect(loaded.entities[meshId]).toEqual(doc.entities[meshId]);
    expect(serializeDocument(loaded)).toBe(text);
  });

  it('refuses a mesh whose uvs or normals do not match its vertex count', () => {
    const { doc, meshId } = build();
    expect(loadError(edit(doc, (raw) => put(raw, ['entities', meshId, 'mesh', 'uvs'], [0, 0, 1])))).toContain('mesh.uvs');
    expect(loadError(edit(doc, (raw) => put(raw, ['entities', meshId, 'mesh', 'normals'], [0, 0, 1])))).toContain('mesh.normals');
  });

  it('refuses malformed material and entity appearances and references to textures that do not exist', () => {
    const { doc, meshId } = build();
    expect(loadError(edit(doc, (raw) => put(raw, ['materials', 'steel', 'appearance'], { roughness: { value: 3 } })))).toContain(
      'roughness',
    );
    expect(loadError(edit(doc, (raw) => put(raw, ['materials', 'steel', 'appearance'], { ior: 9 })))).toContain('ior');
    expect(loadError(edit(doc, (raw) => put(raw, ['materials', 'steel', 'appearance'], { normal: {} })))).toContain('normal');
    expect(loadError(edit(doc, (raw) => put(raw, ['entities', meshId, 'appearance'], { baseColor: { value: 'red' } })))).toContain(
      'baseColor',
    );
    expect(loadError(edit(doc, (raw) => put(raw, ['entities', meshId, 'appearance'], 5)))).toContain('appearance');
    expect(
      loadError(edit(doc, (raw) => put(raw, ['materials', 'steel', 'appearance'], { roughness: { texture: 'tex-ghost' } }))),
    ).toContain('unknown texture');
    expect(
      loadError(
        edit(doc, (raw) => put(raw, ['entities', meshId, 'appearance'], { emission: { texture: doc.appearance?.textureOrder[1] } })),
      ),
    ).toContain('hdr texture');
  });

  it('refuses a malformed slice: texture record, order, budget, environment', () => {
    const { doc } = build();
    const [first, second] = doc.appearance?.textureOrder as [string, string];
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance'], 3)))).toContain('appearance');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance'], { textures: {} })))).toContain('appearance');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textures', first, 'key'], 'short')))).toContain('key');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textures', first, 'format'], 'gif')))).toContain('format');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textures', first, 'width'], 9000)))).toContain('width');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textures', first, 'bytes'], -1)))).toContain('bytes');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textures', first, 'colorSpace'], 'p3')))).toContain('colorSpace');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textures', first, 'id'], 'other')))).toContain('id');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'textureOrder'], [first])))).toContain('textureOrder');
    expect(
      loadError(
        edit(doc, (raw) => {
          for (const id of [first, second])
            put(raw, ['appearance', 'textures', id], {
              ...(((raw['appearance'] as Json)['textures'] as Json)[id] as Json),
              width: 8192,
              height: 8192,
              format: 'hdr',
            });
        }),
      ),
    ).toContain('budget');
    expect(
      loadError(edit(doc, (raw) => put(raw, ['appearance', 'environment'], { source: 'sky', turbidity: 99, intensity: 1 }))),
    ).toContain('turbidity');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'environment'], { source: 'color', color: 'x', intensity: 1 })))).toContain(
      'environment.color',
    );
    expect(
      loadError(edit(doc, (raw) => put(raw, ['appearance', 'environment'], { source: 'sky', turbidity: 3, intensity: -1 }))),
    ).toContain('intensity');
    expect(
      loadError(edit(doc, (raw) => put(raw, ['appearance', 'environment'], { source: 'hdr', texture: first, rotation: 0, intensity: 1 }))),
    ).toContain('hdr texture');
    expect(
      loadError(
        edit(doc, (raw) => put(raw, ['appearance', 'environment'], { source: 'hdr', texture: second, rotation: null, intensity: 1 })),
      ),
    ).toContain('rotation');
    expect(loadError(edit(doc, (raw) => put(raw, ['appearance', 'environment'], { source: 'lava', intensity: 1 })))).toContain(
      'environment.source',
    );
  });
});
