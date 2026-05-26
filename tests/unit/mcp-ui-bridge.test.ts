/**
 * Unit tests for the KI1-followup UI↔MCP live-sync bridge.
 *
 * Tests cover:
 *   - UiBridge interface contract (via a fake implementation)
 *   - bridgeTools: applyBridgeToolCall (happy + failure paths)
 *   - buildBridgeToolDefinitions (schema + annotations)
 *   - applyBridgeToolCall correctly threads the bridge (no module-level singleton)
 *
 * All tests are pure: no network, no DOM, no SDK.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';
import { execute } from '@core/commands/registry';
import {
  buildBridgeToolDefinitions,
  applyBridgeToolCall,
} from '@core/mcp';
import type { UiBridge } from '@core/mcp';

// ---------------------------------------------------------------------------
// Fake UiBridge implementations
// ---------------------------------------------------------------------------

/** A bridge that always returns a document (happy path). */
function makeFakeBridge(liveDoc: CadDocument | null = null): UiBridge & {
  publishedDoc: CadDocument | null;
} {
  let _liveDoc = liveDoc;
  let _publishedDoc: CadDocument | null = null;

  return {
    getLiveDocument(): CadDocument | null {
      return _liveDoc;
    },
    async publishDocument(doc: CadDocument): Promise<{ ok: boolean; summary: string }> {
      _publishedDoc = doc;
      return { ok: true, summary: 'Document staged.' };
    },
    get publishedDoc(): CadDocument | null {
      return _publishedDoc;
    },
    set liveDoc(doc: CadDocument | null) {
      _liveDoc = doc;
    },
  } as UiBridge & { publishedDoc: CadDocument | null };
}

/** A bridge whose publishDocument always fails. */
function makeFailingBridge(): UiBridge {
  return {
    getLiveDocument(): CadDocument | null {
      return createEmptyDocument();
    },
    async publishDocument(_doc: CadDocument): Promise<{ ok: boolean; summary: string }> {
      return { ok: false, summary: 'simulated serialisation error' };
    },
  };
}

// ---------------------------------------------------------------------------
// buildBridgeToolDefinitions
// ---------------------------------------------------------------------------

describe('buildBridgeToolDefinitions()', () => {
  it('returns exactly 2 tool definitions', () => {
    expect(buildBridgeToolDefinitions()).toHaveLength(2);
  });

  it('first tool is snapshot_in_from_ui', () => {
    const defs = buildBridgeToolDefinitions();
    expect(defs[0]!.name).toBe('snapshot_in_from_ui');
  });

  it('second tool is snapshot_out_to_ui', () => {
    const defs = buildBridgeToolDefinitions();
    expect(defs[1]!.name).toBe('snapshot_out_to_ui');
  });

  it('snapshot_in_from_ui has readOnlyHint: true', () => {
    const defs = buildBridgeToolDefinitions();
    expect(defs[0]!.annotations?.readOnlyHint).toBe(true);
  });

  it('snapshot_out_to_ui has destructiveHint: true', () => {
    const defs = buildBridgeToolDefinitions();
    expect(defs[1]!.annotations?.destructiveHint).toBe(true);
  });

  it('every tool has a non-empty description', () => {
    for (const def of buildBridgeToolDefinitions()) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool has an inputSchema with type "object"', () => {
    for (const def of buildBridgeToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });

  it('both tools have required:[] (no required params)', () => {
    for (const def of buildBridgeToolDefinitions()) {
      expect(def.inputSchema.required).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// applyBridgeToolCall — unknown tool (falls through)
// ---------------------------------------------------------------------------

describe('applyBridgeToolCall() — unknown tool', () => {
  beforeEach(() => __resetIdCounter());

  it('returns null for a non-bridge tool name', async () => {
    const doc = createEmptyDocument();
    const bridge = makeFakeBridge();
    const result = await applyBridgeToolCall(doc, 'add_box', bridge);
    expect(result).toBeNull();
  });

  it('returns null for an empty string tool name', async () => {
    const doc = createEmptyDocument();
    const bridge = makeFakeBridge();
    const result = await applyBridgeToolCall(doc, '', bridge);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyBridgeToolCall — snapshot_in_from_ui (happy path)
// ---------------------------------------------------------------------------

describe('applyBridgeToolCall() — snapshot_in_from_ui (happy path)', () => {
  beforeEach(() => __resetIdCounter());

  it('returns a non-null result', async () => {
    const sessionDoc = createEmptyDocument();
    const uiDoc = createEmptyDocument();
    const bridge = makeFakeBridge(uiDoc);
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result).not.toBeNull();
  });

  it('result document is the UI doc returned by the bridge', async () => {
    const sessionDoc = createEmptyDocument();
    const uiDoc = createEmptyDocument();
    // Add an entity to the UI doc to distinguish it from the empty session doc.
    const uiDocWithBox = execute(uiDoc, 'add_box', { size: [1, 1, 1] }).document;
    const bridge = makeFakeBridge(uiDocWithBox);
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.document).toBe(uiDocWithBox);
  });

  it('isError is false', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge(createEmptyDocument());
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.isError).toBe(false);
  });

  it('summary mentions snapshot_in_from_ui', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge(createEmptyDocument());
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.content[0]!.text).toContain('snapshot_in_from_ui');
  });

  it('summary includes entity count', async () => {
    const sessionDoc = createEmptyDocument();
    const uiDoc = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;
    const bridge = makeFakeBridge(uiDoc);
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.content[0]!.text).toContain('1 entity');
  });

  it('does not mutate the input session doc', async () => {
    const sessionDoc = createEmptyDocument();
    const snapshot = JSON.stringify(sessionDoc);
    const bridge = makeFakeBridge(createEmptyDocument());
    await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(JSON.stringify(sessionDoc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// applyBridgeToolCall — snapshot_in_from_ui (bridge returns null)
// ---------------------------------------------------------------------------

describe('applyBridgeToolCall() — snapshot_in_from_ui (bridge returns null)', () => {
  beforeEach(() => __resetIdCounter());

  it('returns a non-null result (graceful no-op)', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge(null);   // no live doc
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result).not.toBeNull();
  });

  it('result document is the unchanged session doc', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge(null);
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.document).toBe(sessionDoc);
  });

  it('isError is false (graceful no-op, not an error)', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge(null);
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.isError).toBe(false);
  });

  it('summary explains that no UI document is available', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge(null);
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridge);
    expect(result!.content[0]!.text).toMatch(/no UI document available/i);
  });
});

// ---------------------------------------------------------------------------
// applyBridgeToolCall — snapshot_out_to_ui (happy path)
// ---------------------------------------------------------------------------

describe('applyBridgeToolCall() — snapshot_out_to_ui (happy path)', () => {
  beforeEach(() => __resetIdCounter());

  it('returns a non-null result', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result).not.toBeNull();
  });

  it('result document is the same reference as the input (session doc unchanged)', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result!.document).toBe(sessionDoc);
  });

  it('isError is false', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result!.isError).toBe(false);
  });

  it('summary mentions snapshot_out_to_ui', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFakeBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result!.content[0]!.text).toContain('snapshot_out_to_ui');
  });

  it('calls bridge.publishDocument with the session doc', async () => {
    const sessionDoc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const bridge = makeFakeBridge();
    await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    // publishedDoc is the doc passed to publishDocument (same reference for the fake bridge).
    expect(bridge.publishedDoc).toBe(sessionDoc);
  });

  it('does not mutate the input session doc', async () => {
    const sessionDoc = createEmptyDocument();
    const snapshot = JSON.stringify(sessionDoc);
    const bridge = makeFakeBridge();
    await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(JSON.stringify(sessionDoc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// applyBridgeToolCall — snapshot_out_to_ui (publish fails)
// ---------------------------------------------------------------------------

describe('applyBridgeToolCall() — snapshot_out_to_ui (publish fails)', () => {
  beforeEach(() => __resetIdCounter());

  it('returns a non-null result', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFailingBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result).not.toBeNull();
  });

  it('isError is true when publishDocument returns ok:false', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFailingBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result!.isError).toBe(true);
  });

  it('result document is the unchanged session doc even on failure', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFailingBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result!.document).toBe(sessionDoc);
  });

  it('summary includes the failure reason', async () => {
    const sessionDoc = createEmptyDocument();
    const bridge = makeFailingBridge();
    const result = await applyBridgeToolCall(sessionDoc, 'snapshot_out_to_ui', bridge);
    expect(result!.content[0]!.text).toContain('simulated serialisation error');
  });
});

// ---------------------------------------------------------------------------
// Bridge threading — bridge is passed through, not a singleton
// ---------------------------------------------------------------------------

describe('applyBridgeToolCall() — bridge threading', () => {
  beforeEach(() => __resetIdCounter());

  it('two separate bridges are independent (no cross-contamination)', async () => {
    const docA = createEmptyDocument();
    const docB = execute(createEmptyDocument(), 'add_box', { size: [5, 5, 5] }).document;

    const bridgeA = makeFakeBridge(docA);
    const bridgeB = makeFakeBridge(docB);

    const sessionDoc = createEmptyDocument();

    const resultA = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridgeA);
    const resultB = await applyBridgeToolCall(sessionDoc, 'snapshot_in_from_ui', bridgeB);

    expect(resultA!.document).toBe(docA);
    expect(resultB!.document).toBe(docB);
    // Confirm docA and docB are different (one has a box)
    expect(Object.keys(resultA!.document.entities)).toHaveLength(0);
    expect(Object.keys(resultB!.document.entities)).toHaveLength(1);
  });
});
