/** 09 PLM M6: the validation properties of a LOTAR archive (lotar_validation_properties) and their comparison. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { type ValidationProperties, compareValidation, documentOfSnapshot, validationPropertiesOf } from '@plm/lotar/validation';
import { inWork, releasedB, released } from './fixtures';
import { run } from './scenarioRunner';

interface Data {
  revision: string;
  definitionHash: string | null;
  source: string;
  validation: ValidationProperties;
}

const properties = (doc: CadDocument, params: Record<string, unknown> = {}): { data: Data; summary: string } => {
  const result = run(doc, 'lotar_validation_properties', params);
  expect(result.rejected, result.summary).toBeUndefined();
  return { data: result.data as Data, summary: result.summary };
};

describe('lotar_validation_properties', () => {
  it('measures the live definition of the open revision: volume, area, centroid and counts of every 3D entity', () => {
    const { data, summary } = properties(inWork());
    expect(data).toMatchObject({ revision: 'A', source: 'live definition' });
    expect(data.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.validation.schema).toBe('llull-validation-1');
    expect(data.validation.counts.solids).toBeGreaterThan(0);
    const [first] = data.validation.solids;
    expect(first?.volume).toBeGreaterThan(0);
    expect(first?.centroid).toHaveLength(3);
    expect(summary).toContain('live definition');
  });

  it('measures a frozen revision from its release snapshot, equal to the live figures while the definition is unchanged', () => {
    const doc = released();
    const frozen = properties(doc, { revision: 'A' });
    expect(frozen.data.source).toBe('release snapshot');
    expect(frozen.data.definitionHash).toBe(doc.plm?.item.revisions['A']?.contentHash);
    expect(frozen.data.validation).toEqual(validationPropertiesOf(doc));
  });

  it('keeps the figures of a superseded revision while the current one has moved on', () => {
    const doc = releasedB();
    const [a, b] = [properties(doc, { revision: 'A' }).data, properties(doc, { revision: 'B' }).data];
    expect(a.definitionHash).not.toBe(b.definitionHash);
    expect(a.source).toBe('release snapshot');
    expect(b.source).toBe('release snapshot');
    expect(a.validation.counts.solids).toBeGreaterThan(0);
  });

  it('is read-only and pure', () => {
    const doc = inWork();
    const result = run(doc, 'lotar_validation_properties', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses an unmanaged document, an unknown revision, a revision without a snapshot, an unreadable vault snapshot and an unloadable one', () => {
    const code = (doc: CadDocument, params: Record<string, unknown> = {}): string | undefined =>
      run(doc, 'lotar_validation_properties', params).error?.code;
    expect(code(createEmptyDocument())).toBe('PLM_NOT_MANAGED');
    const doc = releasedB();
    expect(code(doc, { revision: 'Z' })).toBe('PLM_REVISION_UNKNOWN');
    const plm = doc.plm;
    const revisionA = plm?.item.revisions['A'];
    if (plm === undefined || revisionA === undefined) throw new Error('fixture');
    const withA = (patch: Record<string, unknown>): CadDocument => ({
      ...doc,
      plm: { ...plm, item: { ...plm.item, revisions: { ...plm.item.revisions, A: { ...revisionA, ...patch } } } },
    });
    expect(code(withA({ snapshot: undefined }), { revision: 'A' })).toBe('PLM_NO_SNAPSHOT');
    expect(code(withA({ snapshot: { kind: 'vault', objectSha256: 'a'.repeat(64) } }), { revision: 'A' })).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(code(withA({ snapshot: { kind: 'inline', canonicalJson: '{"nope":1}' } }), { revision: 'A' })).toBe('PLM_INTEGRITY_MISMATCH');
  });
});

describe('compareValidation', () => {
  const base: ValidationProperties = {
    schema: 'llull-validation-1',
    unit: 'mm',
    counts: { entities: 2, solids: 1, components: 0, sheets: 0, pmiItems: 0 },
    solids: [{ id: 'a', name: 'A', kind: 'box', method: 'closed-form', volume: 1000, area: 600, centroid: [5, 5, 5] }],
  };
  const solid = (patch: Partial<ValidationProperties['solids'][number]>): ValidationProperties => ({
    ...base,
    solids: [{ ...(base.solids[0] as ValidationProperties['solids'][number]), ...patch }],
  });

  it('agrees with itself and within the tolerance of the same method', () => {
    expect(compareValidation(base, base)).toEqual([]);
    expect(compareValidation(base, solid({ volume: 1000.0001 }))).toEqual([]);
  });

  it('reports a volume, area or centroid that moved, a changed count and a changed unit', () => {
    expect(compareValidation(base, solid({ volume: 1100 }))).toEqual(['solid a volume: archived 1000, re-derived 1100']);
    expect(compareValidation(base, solid({ area: 1 }))[0]).toContain('area');
    expect(compareValidation(base, solid({ centroid: [5, 9, 5] }))).toEqual(['solid a centroid[1]: archived 5, re-derived 9']);
    expect(compareValidation(base, { ...base, unit: 'in' })).toEqual(['unit: archived mm, re-derived in']);
    expect(compareValidation(base, { ...base, counts: { ...base.counts, sheets: 1 } })).toEqual(['count sheets: archived 0, re-derived 1']);
  });

  it('allows the looser band when the method changed (exact vs mesh), and still reports a real change', () => {
    expect(compareValidation(base, solid({ method: 'mesh', volume: 1000.5 }))).toEqual([]);
    expect(compareValidation(base, solid({ method: 'mesh', volume: 1100 }))).toHaveLength(1);
  });

  it('reports solids that appeared or vanished and treats unmeasured figures as equal only to unmeasured', () => {
    expect(compareValidation(base, { ...base, solids: [] })).toEqual(['solid a is not in the re-derivation']);
    expect(compareValidation({ ...base, solids: [] }, base)).toEqual(['solid a is not in the archive']);
    const unmeasured = solid({ method: 'unmeasured', volume: null, area: null, centroid: null });
    expect(compareValidation(unmeasured, unmeasured)).toEqual([]);
    expect(compareValidation(unmeasured, solid({ method: 'unmeasured' })).length).toBeGreaterThan(0);
  });
});

describe('documentOfSnapshot', () => {
  it('loads a release snapshot and refuses text that is not one', () => {
    const doc = released();
    const text = (doc.plm?.item.revisions['A']?.snapshot as { canonicalJson: string }).canonicalJson;
    expect(documentOfSnapshot(text)?.order.length).toBe(doc.order.length);
    expect(documentOfSnapshot('not json')).toBeNull();
    expect(documentOfSnapshot('[]')).toBeNull();
    expect(documentOfSnapshot('{"document":3}')).toBeNull();
    expect(documentOfSnapshot('{"document":{}}')?.order).toEqual([]);
  });
});
