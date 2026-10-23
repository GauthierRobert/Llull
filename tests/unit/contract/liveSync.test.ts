import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type LiveCommandEvent, applyLiveCommand, documentHash } from '@protocol/liveSync';

function serverStep(name: string, params: unknown): LiveCommandEvent {
  const after = execute(createEmptyDocument(), name, params).document;
  return { epoch: 'e', seq: 1, name, params, stateHash: documentHash(after) };
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

describe('documentHash covers every part of the document', () => {
  const doc = execute(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document, 'add_sphere', { radius: 2 }).document;
  const [firstId = '', secondId = ''] = doc.order;
  const firstEntity = doc.entities[firstId]!;
  it('is the same for an equal document rebuilt from JSON (new object identities)', () => {
    expect(documentHash(JSON.parse(JSON.stringify(doc)) as typeof doc)).toBe(documentHash(doc));
  });
  it('changes when one entity field changes', () => {
    const edited = { ...doc, entities: { ...doc.entities, [firstId]: { ...firstEntity, color: '#123456' } } };
    expect(documentHash(edited)).not.toBe(documentHash(doc));
  });
  it('changes when an entity is added, removed, or keyed differently', () => {
    const { [secondId]: removed, ...remaining } = doc.entities;
    expect(removed).toBeDefined();
    expect(documentHash({ ...doc, entities: remaining })).not.toBe(documentHash(doc));
    const renamed = { ...doc.entities, other: { ...firstEntity } };
    delete (renamed as Record<string, unknown>)[firstId];
    expect(documentHash({ ...doc, entities: renamed })).not.toBe(documentHash(doc));
  });
  it('changes when entity order, feature history, or any other field changes', () => {
    expect(documentHash({ ...doc, order: [...doc.order].reverse() })).not.toBe(documentHash(doc));
    const [step, ...later] = doc.featureHistory;
    expect(documentHash({ ...doc, featureHistory: later })).not.toBe(documentHash(doc));
    expect(documentHash({ ...doc, featureHistory: [{ ...step!, suppressed: true }, ...later] })).not.toBe(documentHash(doc));
    expect(documentHash({ ...doc, units: 'in' })).not.toBe(documentHash(doc));
  });
  it('is sensitive to the order of the entity bag, which replay reproduces', () => {
    const reordered = Object.fromEntries(Object.entries(doc.entities).reverse());
    expect(documentHash({ ...doc, entities: reordered })).not.toBe(documentHash(doc));
  });
});

describe('documentHash memoization', () => {
  it('returns the same value for the same document object and recomputes for a new one', () => {
    const doc = execute(createEmptyDocument(), 'add_box', {}).document;
    expect(documentHash(doc)).toBe(documentHash(doc));
    expect(documentHash({ ...doc })).toBe(documentHash(doc));
  });
});

describe('commands that need the host mesh asset store (renderer re-run without it)', () => {
  it('a command applied on the host with the store diverges in a renderer without it: the mismatch triggers the snapshot fallback', async () => {
    const { defaultContext } = await import('@core/commands/context');
    const key = 'a'.repeat(64);
    const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] };
    const hostContext = {
      ...defaultContext(),
      meshAssets: {
        manifest: () => ({ key, triangles: 1, vertices: 3, bounds }),
        readMesh: () => mesh,
        writeMesh: () => ({ key, triangles: 1, vertices: 3, bounds }),
        readFile: () => null,
      },
    };
    const host = execute(createEmptyDocument(), 'attach_mesh_asset', { assetKey: key }, hostContext);
    expect(host.affected).toHaveLength(1);
    const event: LiveCommandEvent = {
      epoch: 'e',
      seq: 1,
      name: 'attach_mesh_asset',
      params: { assetKey: key },
      stateHash: documentHash(host.document),
    };
    expect(applyLiveCommand(createEmptyDocument(), 0, event)).toEqual({ ok: false, reason: 'mismatch' });
  });
});
