/**
 * Unit tests for commandBus.ts
 *
 * Covers:
 *   (a) applyCommand — mutating command updates live doc + pushes undo history.
 *   (b) applyCommand — query command (mass_properties) returns data, no history/broadcast.
 *   (c) applyCommand — no-op (graceful bad params) pushes nothing.
 *   (d) applyCommand — unknown command → isError true, doc unchanged.
 *   (e) undo/redo — move through history, update canUndo/canRedo.
 *   (f) canUndo / canRedo — state reflects stack sizes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { frameEntityIds, makeFakeRes, parseSseFrame } from './sseTestHelpers';
import { boxRowPlan } from '../../tests/helpers/boxRowPlan';
import { applyCommand, undo, redo, canUndo, canRedo, _resetHistory } from '../src/commandBus';
import { getLiveDoc, _resetLiveDoc, subscribeLive } from '../src/liveDocument';

const BOX = { size: [1, 1, 1], position: [0, 0, 0] };
const BOX2 = { size: [2, 2, 2], position: [5, 0, 0] };
const entityCount = (): number => Object.keys(getLiveDoc().entities).length;

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

describe('applyCommand', () => {
  it('a mutation adds to the live document, enables undo and accumulates', () => {
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    const result = applyCommand('add_box', BOX);
    expect(result.isError).toBe(false);
    expect(result.affected).toHaveLength(1);
    expect(result.canUndo).toBe(true);
    expect(result.canRedo).toBe(false);
    expect(entityCount()).toBe(1);
    applyCommand('add_box', BOX2);
    expect(entityCount()).toBe(2);
    expect(canUndo()).toBe(true);
  });

  it('broadcasts a mutation as a command event, but not a query', () => {
    const fakeRes = makeFakeRes();
    const unsub = subscribeLive(fakeRes);
    expect(fakeRes.written).toHaveLength(1); // opening snapshot
    applyCommand('add_box', BOX);
    expect(fakeRes.written).toHaveLength(2);
    const msg = fakeRes.written[1] ?? '';
    expect(parseSseFrame(msg).event).toBe('command');
    expect(parseSseFrame(msg).data['name']).toBe('add_box');
    expect(frameEntityIds(msg)).toHaveLength(1);
    applyCommand('mass_properties', { entityId: Object.keys(getLiveDoc().entities)[0] ?? '' });
    expect(fakeRes.written).toHaveLength(2);
    unsub();
  });

  it('a command event names its channel and echoes the sender commandId', () => {
    const fakeRes = makeFakeRes();
    const unsub = subscribeLive(fakeRes);
    applyCommand('add_box', BOX, 'cmd-own', 'cli');
    applyCommand('add_box', BOX2);
    unsub();
    const [, first, second] = fakeRes.written.map((frame) => parseSseFrame(frame).data);
    expect(first).toMatchObject({ source: 'cli', commandId: 'cmd-own' });
    expect(second?.['source']).toBe('rest');
    expect(second).not.toHaveProperty('commandId');
  });

  it('a query returns data without touching the document or history', () => {
    applyCommand('add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    _resetHistory();
    const docBefore = getLiveDoc();
    const result = applyCommand('mass_properties', { entityId: Object.keys(docBefore.entities)[0] });
    expect(result.isError).toBe(false);
    expect(result.data).toBeDefined();
    expect(getLiveDoc()).toBe(docBefore);
    expect(result.canUndo).toBe(false);
  });

  it('a graceful no-op pushes no history', () => {
    const result = applyCommand('delete_entities', { ids: ['nonexistent-id'] });
    expect(result.isError).toBe(false);
    expect(result.canUndo).toBe(false);
  });

  it.each([
    ['totally_unknown_command', {}, /./],
    ['add_box', { size: 'big' }, /rejected: invalid params/],
  ])('%s %j is an error and leaves the doc unchanged', (name, params, summary) => {
    const docBefore = getLiveDoc();
    const result = applyCommand(name, params);
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(summary);
    expect(getLiveDoc()).toBe(docBefore);
    expect(result.canUndo).toBe(false);
  });
});

describe('undo / redo', () => {
  it.each([
    [undo, 'Nothing to undo.'],
    [redo, 'Nothing to redo.'],
  ])('an empty stack is a normal result: %#', (travel, summary) => {
    const result = travel();
    expect(result.isError).toBe(false);
    expect(result.summary).toBe(summary);
    expect(result.canUndo).toBe(false);
    expect(result.canRedo).toBe(false);
  });

  it('undo reverts, redo re-applies, and flags follow the stacks', () => {
    applyCommand('add_box', BOX);
    applyCommand('add_box', BOX2);
    const u1 = undo();
    expect(u1.summary).toBe('Undid last change.');
    expect([u1.canUndo, u1.canRedo]).toEqual([true, true]);
    expect(entityCount()).toBe(1);
    const u2 = undo();
    expect([u2.canUndo, u2.canRedo]).toEqual([false, true]);
    expect(entityCount()).toBe(0);
    const r1 = redo();
    expect(r1.summary).toBe('Redid last change.');
    expect([r1.canUndo, r1.canRedo]).toEqual([true, true]);
    expect(entityCount()).toBe(1);
  });

  it('a new mutation clears redo', () => {
    applyCommand('add_box', BOX);
    undo();
    expect(canRedo()).toBe(true);
    applyCommand('add_box', BOX2);
    expect(canRedo()).toBe(false);
  });

  it('undo broadcasts the restored document as a snapshot', () => {
    applyCommand('add_box', BOX);
    const fakeRes = makeFakeRes();
    const unsub = subscribeLive(fakeRes);
    const writesBefore = fakeRes.written.length;
    undo();
    expect(fakeRes.written).toHaveLength(writesBefore + 1);
    const msg = fakeRes.written.at(-1) ?? '';
    expect(parseSseFrame(msg).event).toBe('snapshot');
    expect(frameEntityIds(msg)).toHaveLength(0);
    unsub();
  });
});

describe('applyCommand — idempotent commandId', () => {
  it('a repeated commandId returns the first result without re-applying', () => {
    const first = applyCommand('add_box', { size: [1, 1, 1] }, 'cmd-1');
    const repeat = applyCommand('add_box', { size: [1, 1, 1] }, 'cmd-1');
    expect(repeat).toEqual(first);
    expect(getLiveDoc().order).toHaveLength(1);
  });

  it('a replay keeps small result data but drops a huge payload and says so', () => {
    const small = applyCommand('build_project', boxRowPlan(2), 'small');
    expect(small.data).toBeDefined();
    expect(applyCommand('build_project', boxRowPlan(2), 'small')).toEqual(small);

    const big = applyCommand('build_project', boxRowPlan(400), 'big');
    expect(JSON.stringify(big.data).length).toBeGreaterThan(64 * 1024);
    const replay = applyCommand('build_project', boxRowPlan(400), 'big');
    expect(replay.data).toBeUndefined();
    expect(replay.affected).toEqual(big.affected);
    expect(replay.changed).toBe(true);
    expect(replay.summary).toContain(big.summary);
    expect(replay.summary).toContain('result data was not kept');
    expect(getLiveDoc().order).toHaveLength(2 + 400); // never re-applied
  });

  it('different ids apply independently, and calls without an id are never cached', () => {
    applyCommand('add_box', { size: [1, 1, 1] }, 'a');
    applyCommand('add_box', { size: [1, 1, 1] }, 'b');
    applyCommand('add_box', { size: [1, 1, 1] });
    applyCommand('add_box', { size: [1, 1, 1] });
    expect(getLiveDoc().order).toHaveLength(4);
  });

  it('the cache is a bounded LRU: the oldest id is evicted after 1000 entries', () => {
    applyCommand('add_box', { size: [1, 1, 1] }, 'first');
    for (let index = 0; index < 1000; index++) applyCommand('add_box', { size: [1, 1, index + 2] }, `q-${index}`);
    const before = getLiveDoc().order.length;
    applyCommand('add_box', { size: [1, 1, 1] }, 'first'); // evicted -> applies again
    expect(getLiveDoc().order.length).toBe(before + 1);
  });

  it('a recently used id survives eviction', () => {
    applyCommand('add_box', { size: [1, 1, 1] }, 'keep');
    for (let index = 0; index < 998; index++) applyCommand('mass_properties', { id: 'none' }, `f-${index}`);
    applyCommand('add_box', { size: [1, 1, 1] }, 'keep'); // refresh LRU position
    applyCommand('mass_properties', { id: 'none' }, 'push-1');
    applyCommand('mass_properties', { id: 'none' }, 'push-2');
    const before = getLiveDoc().order.length;
    applyCommand('add_box', { size: [1, 1, 1] }, 'keep');
    expect(getLiveDoc().order.length).toBe(before);
  });
});

describe('applyCommand — changed flag', () => {
  it('is true for set_parameter even though affected is empty', () => {
    const result = applyCommand('set_parameter', { name: 'width', expression: '10' });
    expect(result.affected).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.isError).toBe(false);
  });

  it('is carried by a cached idempotent replay', () => {
    applyCommand('set_parameter', { name: 'width', expression: '10' }, 'param-1');
    const repeat = applyCommand('set_parameter', { name: 'width', expression: '10' }, 'param-1');
    expect(repeat.changed).toBe(true);
  });

  it('is false for a query and for an empty undo, true for a real undo', () => {
    expect(applyCommand('mass_properties', { id: 'none' }).changed).toBe(false);
    expect(undo().changed).toBe(false);
    applyCommand('add_box', { size: [1, 1, 1] });
    expect(undo().changed).toBe(true);
  });
});

describe('undo/redo — monotonic step counter', () => {
  it('add_box, undo, add_box mints a different id than the undone one', () => {
    const undone = applyCommand('add_box', { size: [1, 1, 1] }).affected[0];
    undo();
    const next = applyCommand('add_box', { size: [1, 1, 1] }).affected[0];
    expect(next).toBeDefined();
    expect(next).not.toBe(undone);
  });

  it('redo never rewinds the counter either', () => {
    applyCommand('add_box', { size: [1, 1, 1] });
    undo();
    const counter = getLiveDoc().nextStepNumber ?? 1;
    redo();
    undo();
    expect(getLiveDoc().nextStepNumber ?? 1).toBeGreaterThanOrEqual(counter);
  });
});
