import { describe, it, expect } from 'vitest';
import { materialsInUse } from '@core/model/materialsInUse';
import { createEmptyDocument, DEFAULT_LAYER_ID, type CadDocument, type Entity } from '@core/model/types';

const box = (id: string, materialId?: string): Entity => ({
  id,
  kind: 'box',
  size: [1, 1, 1],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: DEFAULT_LAYER_ID,
  color: '#808080',
  ...(materialId === undefined ? {} : { materialId }),
});

const documentOf = (entities: Entity[]): CadDocument => ({
  ...createEmptyDocument(),
  entities: Object.fromEntries(entities.map((e) => [e.id, e])),
  order: entities.map((e) => e.id),
});

describe('materialsInUse', () => {
  it('lists the entity ids per material in entity order, component entities included, skipping entities without a material', () => {
    const doc = {
      ...documentOf([box('a', 'steel'), box('b'), box('c', 'steel'), box('d', 'brass')]),
      components: { k: { id: 'k', name: 'K', entities: { x: box('x', 'brass') }, order: ['x'] } },
    };
    expect([...materialsInUse(doc)]).toEqual([
      ['steel', ['a', 'c']],
      ['brass', ['d', 'x']],
    ]);
    expect([...materialsInUse(doc, ['c', 'a', 'missing'])]).toEqual([['steel', ['c', 'a']]]);
  });

  it('scans 10^5 entities of one material in linear time (the export gate runs it on every export)', () => {
    const doc = documentOf(Array.from({ length: 100_000 }, (_, i) => box(`e${i}`, 'steel')));
    const started = performance.now();
    expect(materialsInUse(doc).get('steel')).toHaveLength(100_000);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
