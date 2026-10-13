import { describe, it, expect } from 'vitest';
import { createEmptyDocument, DEFAULT_LAYER_ID } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { build } from '../helpers/addEntity';
import { run } from '../helpers/runFixtures';

const D = DEFAULT_LAYER_ID;
/** Default layer + layer "L" (ids[0]) + a box (ids[1]) on the default layer. */
const {
  doc: base,
  ids: [L, BOX],
} = build(['add_layer', { name: 'L' }], ['add_box', { size: [3, 4, 5], position: [1, 2, 3] }]) as {
  doc: ReturnType<typeof createEmptyDocument>;
  ids: [string, string];
};
const layer = (doc: typeof base, id: string): (typeof base)['layers'][string] => doc.layers[id]!;

describe('layer commands', () => {
  it('add_layer appends a visible, unlocked layer (optional color), purely', () => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'add_layer', { name: 'Walls', color: '#ff0000' });
    expect(r.affected).toHaveLength(1);
    const id = r.affected[0]!;
    expect(r.document.layers[id]).toMatchObject({ name: 'Walls', visible: true, locked: false, color: '#ff0000' });
    expect(r.document.layerOrder).toEqual([D, id]);
    expect(r.summary).toContain(id);
    expectPure(doc, () => execute(doc, 'add_layer', { name: 'Test' }));
  });

  it.each<[string, object, string?]>([
    ['add_layer', { name: '   ' }],
    ['update_layer', { id: 'ghost', name: 'X' }, 'ghost'],
    ['update_layer', { id: D, name: '' }],
    ['update_layer', { id: 'nope', visible: false }],
    ['update_layer', { id: 'ghost', locked: true }],
    ['update_layer', { id: D }, 'at least one'],
    ['update_layer', { id: D, color: 'red' }],
    ['set_entity_layer', { entityId: 'no-entity', layerId: D }, 'no-entity'],
    ['set_entity_layer', { entityId: BOX, layerId: 'no-layer' }, 'no-layer'],
    ['delete_layer', { id: D }, 'default'],
    ['delete_layer', { id: 'ghost' }, 'ghost'],
  ])('%s %j is a no-op', (name, p, summary) => expectNoOp(execute(base, name, p), base, summary));

  it.each<[object, Record<string, unknown>]>([
    [{ name: 'New' }, { name: 'New', visible: true, locked: false }],
    [{ visible: false }, { name: 'L', visible: false, locked: false }],
    [{ locked: true }, { name: 'L', visible: true, locked: true }],
    [
      { name: ' Walls ', visible: false, locked: true, color: '#ff0000' },
      { name: 'Walls', visible: false, locked: true, color: '#ff0000' },
    ],
  ])('update_layer %j changes only those fields', (p, expected) => {
    const r = execute(base, 'update_layer', { id: L, ...p });
    expect(r.affected).toEqual([L]);
    expect(layer(r.document, L)).toMatchObject(expected);
    if ('color' in p) expect(r.summary).toContain('visible = false');
    expectPure(base, () => execute(base, 'update_layer', { id: L, ...p }));
  });

  it('update_layer toggles back and keeps the other state', () => {
    const hidden = run(run(base, 'update_layer', { id: L, locked: true }), 'update_layer', { id: L, visible: false });
    expect(layer(run(hidden, 'update_layer', { id: L, name: 'Renamed' }), L)).toMatchObject({ locked: true, visible: false });
    expect(layer(run(hidden, 'update_layer', { id: L, visible: true }), L).visible).toBe(true);
    expect(layer(run(hidden, 'update_layer', { id: L, locked: false }), L).locked).toBe(false);
  });

  it('set_entity_layer reassigns without touching geometry; a locked source layer refuses', () => {
    expect(base.entities[BOX]!.layerId).toBe(D);
    const r = execute(base, 'set_entity_layer', { entityId: BOX, layerId: L });
    expect(r.affected).toEqual([BOX]);
    expect(r.document.entities[BOX]).toMatchObject({ layerId: L, kind: 'box', position: [1, 2, 3] });
    const locked = run(base, 'update_layer', { id: D, locked: true });
    expectNoOp(execute(locked, 'set_entity_layer', { entityId: BOX, layerId: L }), locked, 'locked');
  });

  it('delete_layer removes the layer and reassigns its entities to the default layer', () => {
    const b2 = build(
      ['add_layer', { name: 'X' }],
      ['add_layer', { name: 'B' }],
      ['add_box', { size: [1, 1, 1] }],
      ['add_box', { size: [2, 2, 2] }],
    );
    const [x, b, e1, e2] = b2.ids as [string, string, string, string];
    const doc = [e1, e2].reduce((d, entityId) => run(d, 'set_entity_layer', { entityId, layerId: x }), b2.doc);
    const r = execute(doc, 'delete_layer', { id: x });
    expect(r.affected).toEqual([x]);
    expect(r.document.layers[x]).toBeUndefined();
    expect(r.document.layerOrder).toEqual([D, b]);
    expect([r.document.entities[e1]!.layerId, r.document.entities[e2]!.layerId]).toEqual([D, D]);
    expect(Object.keys(r.document.entities)).toHaveLength(2);
    expect(r.summary).toContain('2 entit');
    const single = run(base, 'set_entity_layer', { entityId: BOX, layerId: L });
    expect(execute(single, 'delete_layer', { id: L }).summary).toContain('1 entity');
  });

  it('the 4 layer commands are registered tools', () => {
    const names = listCommands().map((c) => c.name);
    const schemaNames = toToolSchemas().map((s) => s.name);
    for (const n of ['add_layer', 'update_layer', 'set_entity_layer', 'delete_layer']) {
      expect(names).toContain(n);
      expect(schemaNames).toContain(n);
    }
    expect(names.length).toBe(schemaNames.length);
  });
});
