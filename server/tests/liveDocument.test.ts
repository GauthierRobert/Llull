import { describe, it, expect, beforeEach } from 'vitest';
import { frameEntityIds, makeFakeRes, parseSseFrame } from './sseTestHelpers';
import { getLiveDoc, getLiveSnapshot, setLiveDoc, subscribeLive, _resetLiveDoc, liveSubscriberCount } from '../src/liveDocument';
import { applyToolCall } from '../../tests/helpers/applyToolCall';
import { createEmptyDocument } from '@core/model/types';

beforeEach(() => {
  _resetLiveDoc();
});

/** What the command bus does after a call: run it on the live doc, store the result. */
function callLive(name: string, params: Record<string, unknown>): ReturnType<typeof applyToolCall> {
  const result = applyToolCall(getLiveDoc(), name, params);
  setLiveDoc(result.document);
  return result;
}
const addBox = (): ReturnType<typeof applyToolCall> => callLive('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
const entityCount = (): number => Object.keys(getLiveDoc().entities).length;

describe('setLiveDoc via applyToolCall', () => {
  it('starts empty; tool calls accumulate entities', () => {
    expect(entityCount()).toBe(0);
    expect(addBox().isError).toBe(false);
    expect(entityCount()).toBe(1);
    expect(getLiveDoc().order).toHaveLength(1);
    callLive('add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    expect(entityCount()).toBe(2);
  });

  it('an unknown tool leaves the live document unchanged', () => {
    const before = getLiveDoc();
    expect(callLive('no_such_tool', {}).isError).toBe(true);
    expect(getLiveDoc()).toBe(before);
  });
});

describe('subscribeLive', () => {
  it('writes the current document as an opening snapshot frame', () => {
    addBox();
    const res = makeFakeRes();
    const unsubscribe = subscribeLive(res);
    expect(res.written).toHaveLength(1);
    const msg = res.written[0] ?? '';
    expect(msg.startsWith('event: snapshot\ndata: ')).toBe(true);
    expect(msg.endsWith('\n\n')).toBe(true);
    expect(frameEntityIds(msg)).toHaveLength(1);
    unsubscribe();
  });

  it('broadcasts a snapshot to every subscriber after setLiveDoc, never to an unsubscribed one', () => {
    const [resA, resB, gone] = [makeFakeRes(), makeFakeRes(), makeFakeRes()];
    const unsubs = [subscribeLive(resA), subscribeLive(resB)];
    subscribeLive(gone)();
    addBox();
    expect(resA.written).toHaveLength(2);
    expect(resB.written).toHaveLength(2);
    expect(gone.written).toHaveLength(1);
    expect(parseSseFrame(resA.written[1] ?? '').event).toBe('snapshot');
    expect(frameEntityIds(resA.written[1] ?? '')).toHaveLength(1);
    unsubs.forEach((unsub) => unsub());
  });

  it('subscriber count tracks subscribe/unsubscribe', () => {
    expect(liveSubscriberCount()).toBe(0);
    const unsub = subscribeLive(makeFakeRes());
    expect(liveSubscriberCount()).toBe(1);
    unsub();
    expect(liveSubscriberCount()).toBe(0);
  });

  it('_resetLiveDoc restores an empty or a given document', () => {
    addBox();
    _resetLiveDoc();
    expect(entityCount()).toBe(0);
    const custom = createEmptyDocument();
    _resetLiveDoc(custom);
    expect(getLiveDoc()).toBe(custom);
  });
});

describe('epoch', () => {
  it('snapshots and command events carry the same per-process epoch', () => {
    const snapshot = getLiveSnapshot();
    expect(snapshot.epoch.length).toBeGreaterThan(0);
    const res = makeFakeRes();
    subscribeLive(res);
    setLiveDoc(createEmptyDocument(), { name: 'noop', params: {} });
    const commandFrame = parseSseFrame(res.written.at(-1) ?? '');
    expect(commandFrame.event).toBe('command');
    expect(commandFrame.data['epoch']).toBe(snapshot.epoch);
  });
});
