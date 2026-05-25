import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument, DEFAULT_LAYER_ID } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

describe('layer commands', () => {
  beforeEach(() => __resetIdCounter());

  // -------------------------------------------------------------------------
  // Purity guard
  // -------------------------------------------------------------------------

  it('is pure — no layer command mutates the input document', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_layer', { name: 'Test' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // -------------------------------------------------------------------------
  // add_layer
  // -------------------------------------------------------------------------

  describe('add_layer', () => {
    it('creates a new layer and appends it to layerOrder', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'add_layer', { name: 'Walls' });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const layer = result.document.layers[id];
      expect(layer).toBeDefined();
      expect(layer!.name).toBe('Walls');
      expect(layer!.visible).toBe(true);
      expect(layer!.locked).toBe(false);
      expect(result.document.layerOrder).toContain(id);
      expect(result.document.layerOrder.at(-1)).toBe(id);
    });

    it('stores optional color on the new layer', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'add_layer', { name: 'Colored', color: '#ff0000' });
      const id = result.affected[0]!;
      expect(result.document.layers[id]!.color).toBe('#ff0000');
    });

    it('preserves existing layers and layerOrder', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'add_layer', { name: 'A' });
      expect(result.document.layerOrder).toContain(DEFAULT_LAYER_ID);
      expect(result.document.layerOrder).toHaveLength(2);
    });

    it('rejects empty name — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'add_layer', { name: '   ' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('summary contains the new layer id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'add_layer', { name: 'X' });
      const id = result.affected[0]!;
      expect(result.summary).toContain(id);
    });
  });

  // -------------------------------------------------------------------------
  // rename_layer
  // -------------------------------------------------------------------------

  describe('rename_layer', () => {
    it('updates the layer name', () => {
      let doc = createEmptyDocument();
      const added = execute(doc, 'add_layer', { name: 'Old' });
      doc = added.document;
      const id = added.affected[0]!;

      const result = execute(doc, 'rename_layer', { id, name: 'New' });
      expect(result.affected).toEqual([id]);
      expect(result.document.layers[id]!.name).toBe('New');
    });

    it('does not change visibility or lock state', () => {
      let doc = createEmptyDocument();
      const added = execute(doc, 'add_layer', { name: 'L' });
      doc = added.document;
      const id = added.affected[0]!;
      // lock and hide it first
      doc = execute(doc, 'set_layer_lock', { id, locked: true }).document;
      doc = execute(doc, 'set_layer_visibility', { id, visible: false }).document;

      const result = execute(doc, 'rename_layer', { id, name: 'Renamed' });
      expect(result.document.layers[id]!.locked).toBe(true);
      expect(result.document.layers[id]!.visible).toBe(false);
    });

    it('missing id — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'rename_layer', { id: 'ghost', name: 'X' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('empty name — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'rename_layer', { id: DEFAULT_LAYER_ID, name: '' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });
  });

  // -------------------------------------------------------------------------
  // set_layer_visibility
  // -------------------------------------------------------------------------

  describe('set_layer_visibility', () => {
    it('hides a visible layer', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'set_layer_visibility', { id: DEFAULT_LAYER_ID, visible: false });
      expect(result.affected).toEqual([DEFAULT_LAYER_ID]);
      expect(result.document.layers[DEFAULT_LAYER_ID]!.visible).toBe(false);
    });

    it('shows a hidden layer', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'set_layer_visibility', { id: DEFAULT_LAYER_ID, visible: false }).document;
      const result = execute(doc, 'set_layer_visibility', { id: DEFAULT_LAYER_ID, visible: true });
      expect(result.document.layers[DEFAULT_LAYER_ID]!.visible).toBe(true);
    });

    it('missing id — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'set_layer_visibility', { id: 'nope', visible: false });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('does not change lock state or name', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'set_layer_lock', { id: DEFAULT_LAYER_ID, locked: true }).document;
      const result = execute(doc, 'set_layer_visibility', { id: DEFAULT_LAYER_ID, visible: false });
      expect(result.document.layers[DEFAULT_LAYER_ID]!.locked).toBe(true);
      expect(result.document.layers[DEFAULT_LAYER_ID]!.name).toBe('Layer 0');
    });
  });

  // -------------------------------------------------------------------------
  // set_layer_lock
  // -------------------------------------------------------------------------

  describe('set_layer_lock', () => {
    it('locks an unlocked layer', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'set_layer_lock', { id: DEFAULT_LAYER_ID, locked: true });
      expect(result.affected).toEqual([DEFAULT_LAYER_ID]);
      expect(result.document.layers[DEFAULT_LAYER_ID]!.locked).toBe(true);
    });

    it('unlocks a locked layer', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'set_layer_lock', { id: DEFAULT_LAYER_ID, locked: true }).document;
      const result = execute(doc, 'set_layer_lock', { id: DEFAULT_LAYER_ID, locked: false });
      expect(result.document.layers[DEFAULT_LAYER_ID]!.locked).toBe(false);
    });

    it('missing id — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'set_layer_lock', { id: 'ghost', locked: true });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('does not change visibility or name', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'set_layer_lock', { id: DEFAULT_LAYER_ID, locked: true });
      expect(result.document.layers[DEFAULT_LAYER_ID]!.visible).toBe(true);
      expect(result.document.layers[DEFAULT_LAYER_ID]!.name).toBe('Layer 0');
    });
  });

  // -------------------------------------------------------------------------
  // set_entity_layer
  // -------------------------------------------------------------------------

  describe('set_entity_layer', () => {
    it('reassigns an entity to a different layer', () => {
      let doc = createEmptyDocument();
      // add a new layer
      const layerResult = execute(doc, 'add_layer', { name: 'Structures' });
      doc = layerResult.document;
      const newLayerId = layerResult.affected[0]!;

      // add an entity (defaults to DEFAULT_LAYER_ID)
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const entityId = boxResult.affected[0]!;
      expect(doc.entities[entityId]!.layerId).toBe(DEFAULT_LAYER_ID);

      // move to new layer
      const result = execute(doc, 'set_entity_layer', { entityId, layerId: newLayerId });
      expect(result.affected).toEqual([entityId]);
      expect(result.document.entities[entityId]!.layerId).toBe(newLayerId);
    });

    it('missing entity — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'set_entity_layer', {
        entityId: 'no-entity',
        layerId: DEFAULT_LAYER_ID,
      });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('no-entity');
    });

    it('missing target layer — no-op, affected:[]', () => {
      let doc = createEmptyDocument();
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const entityId = boxResult.affected[0]!;

      const result = execute(doc, 'set_entity_layer', { entityId, layerId: 'no-layer' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('no-layer');
    });

    it('locked source layer — rejected, no-op, affected:[]', () => {
      let doc = createEmptyDocument();
      // lock the default layer
      doc = execute(doc, 'set_layer_lock', { id: DEFAULT_LAYER_ID, locked: true }).document;

      // add a target layer
      const layerResult = execute(doc, 'add_layer', { name: 'Target' });
      doc = layerResult.document;
      const targetLayerId = layerResult.affected[0]!;

      // add entity (on the now-locked default layer)
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const entityId = boxResult.affected[0]!;

      const result = execute(doc, 'set_entity_layer', { entityId, layerId: targetLayerId });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('locked');
    });

    it('entity geometry is unchanged after reassignment', () => {
      let doc = createEmptyDocument();
      const layerResult = execute(doc, 'add_layer', { name: 'B' });
      doc = layerResult.document;
      const newLayerId = layerResult.affected[0]!;

      const boxResult = execute(doc, 'add_box', { size: [3, 4, 5], position: [1, 2, 3] });
      doc = boxResult.document;
      const entityId = boxResult.affected[0]!;

      const result = execute(doc, 'set_entity_layer', { entityId, layerId: newLayerId });
      const entity = result.document.entities[entityId]!;
      expect(entity.kind).toBe('box');
      expect(entity.position).toEqual([1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // delete_layer
  // -------------------------------------------------------------------------

  describe('delete_layer', () => {
    it('deletes a non-default layer and removes it from layerOrder', () => {
      let doc = createEmptyDocument();
      const added = execute(doc, 'add_layer', { name: 'Temp' });
      doc = added.document;
      const id = added.affected[0]!;

      const result = execute(doc, 'delete_layer', { id });
      expect(result.affected).toEqual([id]);
      expect(result.document.layers[id]).toBeUndefined();
      expect(result.document.layerOrder).not.toContain(id);
    });

    it('reassigns orphaned entities to DEFAULT_LAYER_ID', () => {
      let doc = createEmptyDocument();
      // add new layer
      const layerResult = execute(doc, 'add_layer', { name: 'Orphan Layer' });
      doc = layerResult.document;
      const layerId = layerResult.affected[0]!;

      // add entity and move it to the new layer
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const entityId = boxResult.affected[0]!;
      doc = execute(doc, 'set_entity_layer', { entityId, layerId }).document;
      expect(doc.entities[entityId]!.layerId).toBe(layerId);

      // delete the layer
      const result = execute(doc, 'delete_layer', { id: layerId });
      expect(result.document.entities[entityId]!.layerId).toBe(DEFAULT_LAYER_ID);
      expect(result.summary).toContain('1 entity');
    });

    it('refuses to delete the default layer — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'delete_layer', { id: DEFAULT_LAYER_ID });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('default');
    });

    it('missing id — no-op, affected:[]', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'delete_layer', { id: 'ghost' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('entity count is unchanged after deletion with orphan reassignment', () => {
      let doc = createEmptyDocument();
      const layerResult = execute(doc, 'add_layer', { name: 'X' });
      doc = layerResult.document;
      const layerId = layerResult.affected[0]!;

      // add 2 entities on the new layer
      const box1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = box1.document;
      doc = execute(doc, 'set_entity_layer', { entityId: box1.affected[0]!, layerId }).document;
      const box2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = box2.document;
      doc = execute(doc, 'set_entity_layer', { entityId: box2.affected[0]!, layerId }).document;

      const countBefore = Object.keys(doc.entities).length;
      const result = execute(doc, 'delete_layer', { id: layerId });
      expect(Object.keys(result.document.entities)).toHaveLength(countBefore);
    });

    it('layerOrder does not contain deleted layer id after deletion', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_layer', { name: 'A' });
      doc = r1.document;
      const idA = r1.affected[0]!;
      const r2 = execute(doc, 'add_layer', { name: 'B' });
      doc = r2.document;
      const idB = r2.affected[0]!;

      const result = execute(doc, 'delete_layer', { id: idA });
      expect(result.document.layerOrder).not.toContain(idA);
      expect(result.document.layerOrder).toContain(idB);
      expect(result.document.layerOrder).toContain(DEFAULT_LAYER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: toToolSchemas 1:1 with listCommands (layer entries)
  // -------------------------------------------------------------------------

  it('all 6 layer commands are registered and appear in toToolSchemas', () => {
    const names = listCommands().map((c) => c.name);
    const schemaNames = toToolSchemas().map((s) => s.name);

    const layerCommandNames = [
      'add_layer',
      'rename_layer',
      'set_layer_visibility',
      'set_layer_lock',
      'set_entity_layer',
      'delete_layer',
    ];

    for (const name of layerCommandNames) {
      expect(names).toContain(name);
      expect(schemaNames).toContain(name);
    }
    expect(names.length).toBe(schemaNames.length);
  });
});
