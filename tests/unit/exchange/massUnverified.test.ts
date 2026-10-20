/** mass_properties reports imported bodies whose validation properties were red or not checkable (aerospace 04 TR-XCH-24, VC-XCH-22). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ImportProvenance } from '@core/model/exchange';

const provenance = (reasons: ImportProvenance['unverified']['reasons'], value = true): ImportProvenance => ({
  format: 'step',
  schemaName: null,
  fileName: 'x.stp',
  sha256: 'a',
  productName: 'P',
  sourceUnit: 'mm',
  unverified: { value, reasons },
});

function boxDoc(): { doc: CadDocument; id: string } {
  const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  return { doc: made.document, id: made.affected[0] as string };
}

const data = (
  doc: CadDocument,
  id: string,
): { reviewRequired: { value: boolean; reasons: string[] }; importUnverified?: { value: boolean; reasons: string[] } } =>
  execute(doc, 'mass_properties', { entityId: id }).data as ReturnType<typeof data>;

describe('mass_properties and import provenance', () => {
  it('adds the import reasons to reviewRequired and reports importUnverified', () => {
    const { doc, id } = boxDoc();
    const flagged = { ...doc, exchange: { provenance: { [id]: provenance(['import_gvp_not_checkable']) } } };
    const result = data(flagged, id);
    expect(result.importUnverified).toEqual({ value: true, reasons: ['import_gvp_not_checkable'] });
    expect(result.reviewRequired.reasons).toContain('import_gvp_not_checkable');
    expect(result.reviewRequired.value).toBe(true);
    expect(execute(flagged, 'mass_properties', { entityId: id }).summary).toContain('import_gvp_not_checkable');
  });

  it('reads a verified import without review reasons and a plain body without the field', () => {
    const { doc, id } = boxDoc();
    const verified = { ...doc, exchange: { provenance: { [id]: provenance([], false) } } };
    expect(data(verified, id).importUnverified).toEqual({ value: false, reasons: [] });
    expect(data(verified, id).reviewRequired.reasons).not.toContain('import_gvp_red');
    expect(data(doc, id).importUnverified).toBeUndefined();
  });

  it('reads an instance through its component', () => {
    const { doc, id } = boxDoc();
    const created = execute(doc, 'create_component', { name: 'Part', entityIds: [id], componentId: 'comp-part' });
    const instance = created.affected[0] as string;
    const flagged = { ...created.document, exchange: { provenance: { 'comp-part': provenance(['import_gvp_red']) } } };
    expect(data(flagged, instance).importUnverified?.reasons).toEqual(['import_gvp_red']);
  });
});
