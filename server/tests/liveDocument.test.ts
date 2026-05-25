/**
 * @layer server/tests
 *
 * Unit tests for liveDocument.ts
 *
 * Covers:
 *   (a) A mutating MCP tools/call (via applyMcpToolCall + setLiveDoc) updates the
 *       shared live document: getLiveDoc() reflects the new state.
 *   (b) subscribeLive immediately emits the current snapshot; setLiveDoc broadcasts
 *       a fresh snapshot to every subscriber.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getLiveDoc, setLiveDoc, subscribeLive, _resetLiveDoc, _subscriberCount } from '../src/liveDocument';
import { applyMcpToolCall } from '@core/mcp/dispatch';
import { createEmptyDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// Minimal fake Express Response for SSE tests.
// We only need res.write() and res.end() — both are no-ops that record calls.
// ---------------------------------------------------------------------------

interface FakeResponse {
  written: string[];
  ended: boolean;
  write(chunk: string): boolean;
  end(): void;
}

function makeFakeRes(): FakeResponse {
  return {
    written: [],
    ended: false,
    write(chunk: string): boolean {
      this.written.push(chunk);
      return true;
    },
    end(): void {
      this.ended = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Reset shared state before each test so tests are independent.
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetLiveDoc();
});

// ---------------------------------------------------------------------------
// (a) Mutating MCP tool call updates the shared live document
// ---------------------------------------------------------------------------

describe('setLiveDoc via applyMcpToolCall', () => {
  it('starts with an empty document (0 entities)', () => {
    const doc = getLiveDoc();
    expect(Object.keys(doc.entities)).toHaveLength(0);
  });

  it('after an add_box tool call, getLiveDoc() contains 1 entity', () => {
    const doc = getLiveDoc();
    const result = applyMcpToolCall(doc, 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });

    // Simulate what the MCP router does after a successful call.
    setLiveDoc(result.document);

    expect(result.isError).toBe(false);
    const live = getLiveDoc();
    expect(Object.keys(live.entities)).toHaveLength(1);
    expect(live.order).toHaveLength(1);
  });

  it('successive tool calls accumulate entities in the shared doc', () => {
    // First call
    const r1 = applyMcpToolCall(getLiveDoc(), 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });
    setLiveDoc(r1.document);

    // Second call reads the updated live doc
    const r2 = applyMcpToolCall(getLiveDoc(), 'add_box', {
      size: [2, 2, 2],
      position: [5, 0, 0],
    });
    setLiveDoc(r2.document);

    const live = getLiveDoc();
    expect(Object.keys(live.entities)).toHaveLength(2);
  });

  it('unknown tool name leaves the live document unchanged', () => {
    const before = getLiveDoc();
    const result = applyMcpToolCall(before, 'no_such_tool', {});
    setLiveDoc(result.document);

    expect(result.isError).toBe(true);
    // The document reference returned is the same (no-op).
    expect(getLiveDoc()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// (b) subscribeLive: initial snapshot + broadcast on mutation
// ---------------------------------------------------------------------------

describe('subscribeLive', () => {
  it('immediately writes the current document as an SSE data event on subscribe', () => {
    // Seed the live doc with one entity so the snapshot is non-trivial.
    const r = applyMcpToolCall(getLiveDoc(), 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });
    setLiveDoc(r.document);

    const res = makeFakeRes();
    // Cast: subscribeLive accepts express Response; our fake matches structurally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsubscribe = subscribeLive(res as any);

    // Exactly one SSE message written at subscription time.
    expect(res.written).toHaveLength(1);
    const msg = res.written[0] ?? '';
    expect(msg.startsWith('data: ')).toBe(true);
    expect(msg.endsWith('\n\n')).toBe(true);

    const parsed = JSON.parse(msg.slice('data: '.length)) as Record<string, unknown>;
    expect(typeof parsed['entities']).toBe('object');

    unsubscribe();
  });

  it('broadcasts a fresh snapshot to subscribers after setLiveDoc', () => {
    const resA = makeFakeRes();
    const resB = makeFakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsubA = subscribeLive(resA as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsubB = subscribeLive(resB as any);

    // Both got the initial empty snapshot.
    expect(resA.written).toHaveLength(1);
    expect(resB.written).toHaveLength(1);

    // Now a mutation arrives.
    const r = applyMcpToolCall(getLiveDoc(), 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });
    setLiveDoc(r.document);

    // Each subscriber gets the mutation broadcast (total 2 writes each).
    expect(resA.written).toHaveLength(2);
    expect(resB.written).toHaveLength(2);

    // The second write carries the updated document.
    const mutationMsg = resA.written[1] ?? '';
    const updatedDoc = JSON.parse(mutationMsg.slice('data: '.length)) as Record<string, unknown>;
    const entities = updatedDoc['entities'] as Record<string, unknown>;
    expect(Object.keys(entities)).toHaveLength(1);

    unsubA();
    unsubB();
  });

  it('unsubscribed response no longer receives broadcasts', () => {
    const res = makeFakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsubscribe = subscribeLive(res as any);

    // Unsubscribe before the mutation.
    unsubscribe();

    const r = applyMcpToolCall(getLiveDoc(), 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });
    setLiveDoc(r.document);

    // Still only the initial snapshot write — mutation was not received.
    expect(res.written).toHaveLength(1);
  });

  it('subscriber count tracks subscribe/unsubscribe correctly', () => {
    expect(_subscriberCount()).toBe(0);

    const res = makeFakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeLive(res as any);
    expect(_subscriberCount()).toBe(1);

    unsub();
    expect(_subscriberCount()).toBe(0);
  });

  it('_resetLiveDoc restores an empty document', () => {
    const r = applyMcpToolCall(getLiveDoc(), 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });
    setLiveDoc(r.document);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);

    _resetLiveDoc();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
  });

  it('_resetLiveDoc accepts a custom document', () => {
    const custom = createEmptyDocument();
    _resetLiveDoc(custom);
    expect(getLiveDoc()).toBe(custom);
  });
});
