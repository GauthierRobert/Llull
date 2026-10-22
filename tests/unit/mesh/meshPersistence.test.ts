/** 07 MSH: `meshSource` and `faceGroups` survive save / load and a damaged value is refused by name. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';

const OBJ = 'o part\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';

function imported(): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'import_mesh_file', { text: OBJ, units: 'mm', fileName: 'plate.obj' });
  return { doc: result.document, id: result.affected[0] as string };
}

const envelope = (doc: CadDocument): string => JSON.stringify({ format: 'llull-document', version: 3, document: doc });
const withEntity = (doc: CadDocument, id: string, patch: Partial<MeshSolidEntity>): string =>
  envelope({ ...doc, entities: { ...doc.entities, [id]: { ...(doc.entities[id] as MeshSolidEntity), ...patch } } });
const loadError = (json: string): string => {
  try {
    deserializeDocument(json);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

describe('mesh provenance in saved documents', () => {
  it('round-trips meshSource, faceGroups and the import step exactly', () => {
    const { doc, id } = imported();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded).toEqual(doc);
    const entity = loaded.entities[id] as MeshSolidEntity;
    expect(entity.meshSource).toMatchObject({ format: 'obj', fileName: 'plate.obj', unitScale: 1, verified: false });
    expect(entity.faceGroups).toEqual([{ id: 'part', faces: [[0, 2]] }]);
  });

  it('replays the import from its recorded step to the same entity', () => {
    const { doc, id } = imported();
    const replayed = execute(doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.entities[id]).toEqual(doc.entities[id]);
  });

  it.each([
    [{ meshSource: { format: 'stl-ascii', unitScale: 0, verified: false } }, 'meshSource'],
    [{ meshSource: { format: 'gcode', unitScale: 1, verified: false } }, 'meshSource'],
    [{ meshSource: { format: 'obj', unitScale: 1 } }, 'meshSource'],
    [{ faceGroups: [{ id: 'g', faces: [[0, 99]] }] }, 'faceGroups'],
    [{ faceGroups: [{ id: 'g', faces: [[2, 1]] }] }, 'faceGroups'],
    [{ faceGroups: 'nope' }, 'faceGroups'],
  ] as const)('refuses %j naming %s', (patch, name) => {
    const { doc, id } = imported();
    expect(loadError(withEntity(doc, id, patch as unknown as Partial<MeshSolidEntity>))).toContain(name);
  });
});
