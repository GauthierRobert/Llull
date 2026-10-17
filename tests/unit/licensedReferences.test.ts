/** TR-MAT-32: which params count as referencing a licensed material (direct, via entity, via fastener stack, via plan alias). */
import { describe, expect, it } from 'vitest';
import { hasLicensedMaterial, referencesLicensed } from '@mcp/licensedReferences';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const licensed = { licence: 'licensed-no-redistribution' };
const open = { licence: 'company-proprietary' };

function documentWith(): CadDocument {
  const base = createEmptyDocument();
  return {
    ...base,
    materials: { lic: { name: 'lic', record: licensed }, free: { name: 'free', record: open } },
    entities: { 'box-1': { id: 'box-1', materialId: 'lic' }, 'box-2': { id: 'box-2', materialId: 'free' } },
    fasteners: {
      catalogs: {},
      stacks: { 'fst-1': { layers: [{ entityId: 'box-2' }, { entityId: 'box-1' }] }, 'fst-2': { layers: [{ entityId: 'box-2' }] } },
    },
  } as unknown as CadDocument;
}

describe('referencesLicensed', () => {
  const doc = documentWith();
  it('finds a licensed material, entity or stack anywhere in nested params', () => {
    expect(referencesLicensed(doc, { a: [{ b: 'lic' }] })).toBe(true);
    expect(referencesLicensed(doc, { entityId: 'box-1' })).toBe(true);
    expect(referencesLicensed(doc, { stackId: 'fst-1' })).toBe(true);
  });
  it('ignores open materials, unknown ids and prototype keys', () => {
    expect(referencesLicensed(doc, { material: 'free', stackId: 'fst-2', other: ['constructor', 3, null] })).toBe(false);
  });
  it('resolves plan aliases, and fails closed when they are unknown', () => {
    expect(referencesLicensed(doc, { stackId: '$s' }, { s: ['fst-1'] })).toBe(true);
    expect(referencesLicensed(doc, { stackId: '$s' }, { s: ['fst-2'] })).toBe(false);
    expect(referencesLicensed(doc, { stackId: '$s' })).toBe(hasLicensedMaterial(doc));
  });
});
