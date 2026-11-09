import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { close, emptyMm, run, withMaterial } from './fixtures';

interface Budget {
  perPart: { entityId: string; massG: number | null; maxMassLossG: number | null; maxCondensableG: number | null; note?: string }[];
  totalMassLossG: number;
  totalCondensableG: number;
  counted: number;
  uncounted: number;
}

const budgetOf = (doc: CadDocument, params: Record<string, unknown> = {}): Budget =>
  (execute(doc, 'check_space_environment', { profile: 'nasa_gsfc_screening', ...params }).data as { budget: Budget }).budget;

/** A component holding one 100 x 100 x 16.6667 mm panel (200 g of syn_low) and `count` instances of it (create_component already leaves one). */
function instanced(count: number): CadDocument {
  let doc = withMaterial(emptyMm(), 'syn_low', { TML: 0.95, CVCM: 0.05, WVR: 0.3 });
  const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
  const id = added.affected[0] ?? '';
  doc = run(added.document, 'assign_material', { materialName: 'syn_low', entityIds: [id] }).document;
  doc = run(doc, 'create_component', { name: 'panel', entityIds: [id], componentId: 'panel' }).document;
  for (let k = 1; k < count; k += 1) doc = run(doc, 'insert_instance', { componentId: 'panel', position: [k * 200, 0, 0] }).document;
  return doc;
}

describe('screening budget over component instances (FR-ENV-04)', () => {
  it('counts a component instanced twice twice, and the component definition itself never', () => {
    const budget = budgetOf(instanced(2));
    expect(budget.perPart).toHaveLength(2);
    expect(budget.perPart.every((part) => part.entityId.startsWith('expanded::'))).toBe(true);
    expect(close(budget.totalMassLossG, 2 * 1.9)).toBe(true);
    expect(close(budget.totalCondensableG, 2 * 0.1)).toBe(true);
    expect(budget.counted).toBe(2);
  });

  it('one instance counts once; a scaled instance counts its scaled mass', () => {
    expect(close(budgetOf(instanced(1)).totalMassLossG, 1.9)).toBe(true);
    let doc = instanced(1);
    doc = run(doc, 'insert_instance', { componentId: 'panel', scale: [2, 1, 1], position: [500, 0, 0] }).document;
    expect(close(budgetOf(doc).totalMassLossG, 1.9 + 3.8)).toBe(true);
  });

  it('a part without a TML value is listed with a note and only its CVCM figure is counted', () => {
    let doc = withMaterial(emptyMm(), 'cvcm_only', { CVCM: 0.05 });
    const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
    doc = run(added.document, 'assign_material', { materialName: 'cvcm_only', entityIds: added.affected }).document;
    const part = budgetOf(doc).perPart[0];
    expect(part?.maxMassLossG).toBeNull();
    expect(close(part?.maxCondensableG ?? NaN, 0.1)).toBe(true);
    expect(part?.note).toContain('TML unknown');
  });

  it('a part with a TML value but no CVCM names CVCM in the note', () => {
    let doc = withMaterial(emptyMm(), 'tml_only', { TML: 0.5 });
    const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
    doc = run(added.document, 'assign_material', { materialName: 'tml_only', entityIds: added.affected }).document;
    expect(budgetOf(doc).perPart[0]?.note).toContain('CVCM unknown');
  });

  it('an instance whose component is gone adds no part (no crash)', () => {
    const doc = instanced(1);
    const broken: CadDocument = { ...doc, components: {} };
    expect(budgetOf(broken).perPart).toEqual([]);
  });
});
