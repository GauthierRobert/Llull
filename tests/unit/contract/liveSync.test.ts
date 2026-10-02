/** MG5.1 live sync: command log + state hash; gap/mismatch fall back to a snapshot. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { applyLiveCommand, documentHash } from '@mcp/liveSync';
import type { LiveCommandEvent } from '@mcp/liveSync';

function serverStep(name: string, params: unknown): LiveCommandEvent {
  const after = execute(createEmptyDocument(), name, params).document;
  return { seq: 1, name, params, stateHash: documentHash(after) };
}

describe('live sync protocol', () => {
  it('a client re-running the broadcast command reaches the server state hash', () => {
    const event = serverStep('add_box', { size: [1, 2, 3] });
    const applied = applyLiveCommand(createEmptyDocument(), 0, event);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.document.order).toEqual(['box-1.1']);
  });

  it('reports a gap when the event is not the next log entry', () => {
    const event = { ...serverStep('add_box', { size: [1, 1, 1] }), seq: 5 };
    expect(applyLiveCommand(createEmptyDocument(), 0, event)).toEqual({ ok: false, reason: 'gap' });
  });

  it('reports a mismatch when the client state diverged', () => {
    const event = serverStep('add_box', { size: [1, 1, 1] });
    const diverged = execute(createEmptyDocument(), 'add_sphere', { radius: 1 }).document;
    expect(applyLiveCommand(diverged, 0, event)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('ignores per-client selection in the hash', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    expect(documentHash({ ...doc, selection: doc.order })).toBe(documentHash(doc));
    expect(documentHash(createEmptyDocument())).not.toBe(documentHash(doc));
  });
});
