import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { replaceEntitiesById, replaceEntity } from '@core/commands/entityOps';

describe('replaceEntitiesById', () => {
  const base = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const boxId = base.affected[0]!;
  const second = execute(base.document, 'add_box', { size: [2, 2, 2] });
  const doc = second.document;
  const changed = [boxId, second.affected[0]!].map((id) => ({
    ...doc.entities[id]!,
    color: '#123456',
  }));

  it('equals folding replaceEntity, keeps order and does not mutate the input', () => {
    const snapshot = JSON.stringify(doc);
    const bulk = replaceEntitiesById(doc, changed);
    expect(bulk).toEqual(changed.reduce(replaceEntity, doc));
    expect(bulk.order).toBe(doc.order);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('returns the same document for an empty list', () => {
    expect(replaceEntitiesById(doc, [])).toBe(doc);
  });
});

describe('commands built on it', () => {
  it('delete_layer reassigns every orphan to the default layer', () => {
    const layer = execute(createEmptyDocument(), 'add_layer', { name: 'Temp' });
    const layerId = layer.affected[0]!;
    let doc = layer.document;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const box = execute(doc, 'add_box', { size: [1, 1, 1], position: [i * 3, 0, 0] });
      const assigned = execute(box.document, 'set_entity_layer', {
        entityId: box.affected[0]!,
        layerId,
      });
      doc = assigned.document;
      ids.push(box.affected[0]!);
    }
    const result = execute(doc, 'delete_layer', { id: layerId });
    expect(result.summary).toContain('5 entity(s) reassigned');
    for (const id of ids) {
      expect(result.document.entities[id]!.layerId).toBe(result.document.layerOrder[0]);
    }
  });

  it('align moves many targets in one step', () => {
    const reference = execute(createEmptyDocument(), 'add_box', {
      size: [2, 2, 2],
      position: [50, 0, 0],
    });
    let doc = reference.document;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const box = execute(doc, 'add_box', { size: [2, 2, 2], position: [i * 4, 10, 0] });
      doc = box.document;
      ids.push(box.affected[0]!);
    }
    const result = execute(doc, 'align', {
      targetIds: ids,
      edge: 'center-x',
      referenceId: reference.affected[0]!,
    });
    expect(result.affected.length).toBeGreaterThan(0);
    for (const id of ids) expect(result.document.entities[id]!.position[0]).toBeCloseTo(50);
  });
});
