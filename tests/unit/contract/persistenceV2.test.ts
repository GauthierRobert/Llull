/** MG3.2 / MG4.2 file format v2: definition stored, building geometry re-derived on load. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { derivedEntityIds } from '@core/model/partition';

function hall(): CadDocument {
  let doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  doc = execute(doc, 'add_portal_frame_building', {
    span: 18000,
    length: 30000,
    baySpacing: 6000,
    eaveHeight: 6000,
    roofPitch: 6,
  }).document;
  return execute(doc, 'add_sphere', { radius: 1 }).document;
}

describe('llull-document v2', () => {
  it('omits building-generated entities from the file and restores them exactly on load', () => {
    const doc = hall();
    const derived = derivedEntityIds(doc);
    expect(derived.size).toBeGreaterThan(10);
    const compact = serializeDocument(doc);
    const full = serializeDocument(doc, { includeDerived: true });
    expect(compact.length).toBeLessThan(full.length / 2);
    const stored = JSON.parse(compact) as { version: number; document: CadDocument };
    expect(stored.version).toBe(2);
    expect(Object.keys(stored.document.entities)).toHaveLength(
      Object.keys(doc.entities).length - derived.size,
    );

    const loaded = deserializeDocument(compact);
    expect(loaded.entities).toEqual(doc.entities);
    expect(loaded.order).toEqual(doc.order);
    expect(loaded.building).toEqual(doc.building);
  });

  it('keeps the step counter so new steps never reuse ids', () => {
    const doc = hall();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.nextStepNumber).toBe(doc.nextStepNumber);
    const next = execute(loaded, 'add_box', { size: [1, 1, 1] });
    expect(next.affected[0]).toBe(`box-${doc.nextStepNumber ?? 0}.1`);
  });

  it('still reads v1 files (legacy ids, no step counter)', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const legacyId = 'box-lz3k9q-5';
    const box = { ...doc.entities[doc.order[0] ?? '']!, id: legacyId };
    const legacy: Partial<CadDocument> = {
      ...doc,
      entities: { [legacyId]: box },
      order: [legacyId],
      featureHistory: [],
    };
    delete legacy.nextStepNumber;
    const v1 = JSON.stringify({ format: 'llull-document', version: 1, document: legacy });
    const loaded = deserializeDocument(v1);
    expect(loaded.entities[legacyId]).toEqual(box);
    expect(execute(loaded, 'add_box', { size: [1, 1, 1] }).affected[0]).toBe('box-1.1');
  });

  it('never lets a missing or stale counter re-mint an existing step-scoped id', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stale: Partial<CadDocument> = { ...doc };
    delete stale.nextStepNumber;
    const loaded = deserializeDocument(
      JSON.stringify({ format: 'llull-document', version: 2, document: stale }),
    );
    expect(loaded.nextStepNumber).toBe(3);
    const created = execute(loaded, 'add_box', { size: [1, 1, 1] }).affected[0] ?? '';
    expect(doc.entities[created]).toBeUndefined();
  });

  it('load_document re-derives building geometry from a compact file', () => {
    const doc = hall();
    const result = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    });
    expect(result.document.entities).toEqual(doc.entities);
  });
});
