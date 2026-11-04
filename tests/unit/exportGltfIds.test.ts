/** VIS-M8d: compact `llullIds` of an instanced glTF node (runs of consecutive numbered ids). */
import { describe, it, expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { instanceIdExtras } from '@core/commands/exchange/gltfIds';
import { createEmptyDocument, DEFAULT_LAYER_ID, type CadDocument, type Entity } from '@core/model/types';
import { nodeInstanceIds } from '../helpers/gltfIds';

describe('instanceIdExtras', () => {
  it('writes consecutive numbered ids as [prefix, first, last] and keeps the others', () => {
    expect(instanceIdExtras(['i1', 'i2', 'i3', 'i4', 'x', 'instance-7.1', 'instance-7.2', 'instance-7.3', 'i9'])).toEqual({
      llullIdRuns: [['i', 1, 4], 'x', ['instance-7.', 1, 3], 'i9'],
    });
  });

  it('keeps the plain list when no run reaches 3 ids (or the ids are not numbered)', () => {
    expect(instanceIdExtras(['a1', 'a2', 'a4', 'a5'])).toEqual({ llullIds: ['a1', 'a2', 'a4', 'a5'] });
    expect(instanceIdExtras(['alpha', 'beta', 'gamma'])).toEqual({ llullIds: ['alpha', 'beta', 'gamma'] });
    expect(instanceIdExtras([])).toEqual({ llullIds: [] });
  });

  it('never merges a leading-zero number, another prefix or a descending sequence', () => {
    expect(instanceIdExtras(['e007', 'e008', 'e009'])).toEqual({ llullIdRuns: [['e00', 7, 9]] });
    expect(instanceIdExtras(['a1', 'b2', 'a3'])).toEqual({ llullIds: ['a1', 'b2', 'a3'] });
    expect(instanceIdExtras(['a3', 'a2', 'a1'])).toEqual({ llullIds: ['a3', 'a2', 'a1'] });
    expect(instanceIdExtras(['a0', 'a1', 'a2'])).toEqual({ llullIdRuns: [['a', 0, 2]] });
  });

  it('keeps a non-numeric id between two runs as a plain entry', () => {
    expect(instanceIdExtras(['a1', 'a2', 'a3', 'odd', 'b7', 'b8', 'b9'])).toEqual({ llullIdRuns: [['a', 1, 3], 'odd', ['b', 7, 9]] });
    expect(instanceIdExtras(['x', 'a1', 'a2', 'a3', 'y'])).toEqual({ llullIdRuns: ['x', ['a', 1, 3], 'y'] });
  });

  it('expanding the runs gives the ids back, in order', () => {
    const ids = ['p', 'e0', 'e1', 'e2', 'e3', 'e5', 'e6', 'e7', 'q-1', 'e99999999999999999999', 'e099', 'e100', 'e101'];
    expect(nodeInstanceIds(instanceIdExtras(ids))).toEqual(ids);
  });
});

function farm(count: number): CadDocument {
  const common = { layerId: DEFAULT_LAYER_ID, color: '#808080', rotation: [0, 0, 0] as const };
  const box: Entity = { ...common, id: 'b', kind: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] };
  const entities: Record<string, Entity> = {};
  const order: string[] = [];
  for (let i = 0; i < count; i++) {
    order.push(`i${i}`);
    entities[`i${i}`] = { ...common, id: `i${i}`, kind: 'instance', componentId: 'c', position: [i, 0, 0] };
  }
  return { ...createEmptyDocument(), entities, order, components: { c: { id: 'c', name: 'C', entities: { b: box }, order: ['b'] } } };
}

describe('export_gltf gpu id extras', () => {
  it('writes llullIdRuns for consecutive instance ids: same ids, far fewer bytes', () => {
    const doc = farm(500);
    const gpu = execute(doc, 'export_gltf', { instancing: 'gpu' }).data as { text: string };
    const node = (JSON.parse(gpu.text) as { nodes: Array<{ extras: Record<string, unknown> }> }).nodes[0];
    expect(node?.extras['llullIdRuns']).toEqual([['i', 0, 499]]);
    expect(node?.extras['llullIds']).toBeUndefined();
    expect(node?.extras['instanceCount']).toBe(500);
    expect(nodeInstanceIds(node?.extras as Parameters<typeof nodeInstanceIds>[0])).toEqual(doc.order);
    expect(JSON.stringify(node?.extras).length).toBeLessThan(120);
  });

  it('keeps the list form for ids that do not run', () => {
    const doc = farm(4);
    const renamed = { ...doc, order: ['i0', 'i2', 'i3', 'i1'] };
    const data = execute(renamed, 'export_gltf', { instancing: 'gpu' }).data as { text: string };
    const node = (JSON.parse(data.text) as { nodes: Array<{ extras: Record<string, unknown> }> }).nodes[0];
    expect(node?.extras['llullIds']).toEqual(['i0', 'i2', 'i3', 'i1']);
  });
});
