/** Incremental regeneration: parameter edits regenerate dependents; replay reuses prefixes. */
import { describe, it, expect } from 'vitest';
import { type BoxEntity, type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createReplayCache } from '@core/commands/replayCache';
import { changedParameters, parametersReadBy, stepsReading } from '@core/commands/dependents';

function parametricBox(): CadDocument {
  let doc = execute(createEmptyDocument(), 'set_parameter', {
    name: 'w',
    expression: '10',
  }).document;
  doc = execute(doc, 'build_project', {
    actions: [
      { command: 'add_sphere', params: { radius: 1 } },
      { command: 'add_box', params: { size: ['=w', 2, 3] } },
    ],
  }).document;
  return doc;
}

describe('parameter dependents', () => {
  it('finds parameters read by nested =expr params', () => {
    expect([
      ...parametersReadBy({ size: ['=w * 2', 3], nested: { h: '=h + w' }, label: 'w' }),
    ]).toEqual(['w', 'h']);
  });

  it('detects changed, added and removed parameter values', () => {
    const a = {
      w: { name: 'w', expression: '1', value: 1 },
      h: { name: 'h', expression: '2', value: 2 },
    };
    const b = {
      w: { name: 'w', expression: '5', value: 5 },
      d: { name: 'd', expression: '1', value: 1 },
    };
    expect([...changedParameters(a, b)].sort()).toEqual(['d', 'h', 'w']);
  });

  it('lists only live steps that read a changed parameter', () => {
    const doc = parametricBox();
    expect(stepsReading(doc.featureHistory, new Set(['w'])).map((s) => s.name)).toEqual([
      'add_box',
    ]);
    expect(stepsReading(doc.featureHistory, new Set())).toEqual([]);
    const suppressed = doc.featureHistory.map((s) => ({ ...s, suppressed: true }));
    expect(stepsReading(suppressed, new Set(['w']))).toEqual([]);
  });

  it('set_parameter regenerates the geometry that reads it', () => {
    const doc = parametricBox();
    const result = execute(doc, 'set_parameter', { name: 'w', expression: '40' });
    const box = Object.values(result.document.entities).find((e) => e.kind === 'box') as BoxEntity;
    expect(box.size[0]).toBe(40);
    expect(result.summary).toContain('regenerated 1 dependent feature step');
  });

  it('set_parameter on an unused parameter leaves the geometry untouched', () => {
    const doc = parametricBox();
    const result = execute(doc, 'set_parameter', { name: 'unused', expression: '3' });
    expect(result.document.entities).toBe(doc.entities);
    expect(result.affected).toEqual([]);
  });
});

describe('replay prefix cache', () => {
  it('serves unchanged prefixes from the cache and stays equal to a cold replay', () => {
    const doc = parametricBox();
    const cache = createReplayCache();
    const warm = { ...defaultContext(), replayCache: cache };
    const first = execute(doc, 'replay_history', {}, warm).document;
    const cached = cache.size;
    expect(cached).toBe(2);
    const second = execute(doc, 'replay_history', {}, warm).document;
    expect(cache.size).toBe(cached);
    expect(second.entities).toEqual(first.entities);
    const cold = execute(doc, 'replay_history', {}, { ...defaultContext(), replayCache: null });
    expect(cold.document.entities).toEqual(first.entities);
  });

  it('evicts the least recently used state beyond capacity', () => {
    const cache = createReplayCache(1);
    const state = { doc: createEmptyDocument(), idMap: new Map<string, string>(), inert: false };
    cache.set('a', state);
    cache.set('b', state);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(state);
    expect(cache.size).toBe(1);
  });
});
