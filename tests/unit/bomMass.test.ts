/** bill_of_materials per-row and total mass (qty x unit), density resolved like mass_properties. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { expectPure } from '../helpers/expectNoOp';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; ids: string[] } {
  const result = execute(doc, name, params);
  expect(result.rejected, result.summary).toBeUndefined();
  return { doc: result.document, ids: result.affected };
}

function bomOf(doc: CadDocument): {
  rows: Array<Record<string, unknown>>;
  totalMassKg: number;
  rowsWithoutDensity: string[];
  summary: string;
} {
  const result = execute(doc, 'bill_of_materials', {});
  return {
    ...(result.data as { rows: Array<Record<string, unknown>>; totalMassKg: number; rowsWithoutDensity: string[] }),
    summary: result.summary,
  };
}

/** Component "block" (10 mm cube, optional steel) x 4, plus a bare component "bare" x 1. */
function assembly(withSteel: boolean): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'create_material', { name: 'steel', density: 0.00785, color: '#888888', metalness: 1, roughness: 0.4 }).doc;
  const box = run(doc, 'add_box', { size: [10, 10, 10] });
  const bare = run(box.doc, 'add_box', { size: [1, 1, 1] });
  let next = bare.doc;
  if (withSteel) next = run(next, 'assign_material', { entityIds: box.ids, materialName: 'steel' }).doc;
  next = run(next, 'create_component', { name: 'block', entityIds: box.ids, componentId: 'blk' }).doc;
  next = run(next, 'create_component', { name: 'bare', entityIds: bare.ids, componentId: 'brx' }).doc;
  for (let k = 1; k < 4; k += 1) next = run(next, 'insert_instance', { componentId: 'blk' }).doc;
  return next;
}

describe('bill_of_materials mass', () => {
  it('reports unit and total mass for a steel box x4 and lists rows without density', () => {
    const doc = assembly(true);
    const bom = bomOf(doc);
    const unitKg = (1000 * 0.00785) / 1000;
    const block = bom.rows.find((r) => r['componentId'] === 'blk');
    expect(block?.['count']).toBe(4);
    expect(block?.['unitMassKg']).toBeCloseTo(unitKg, 9);
    expect(block?.['totalMassKg']).toBeCloseTo(4 * unitKg, 9);
    expect(block?.['massUnverified']).toBe(true);
    expect(String((block?.['massSources'] as string[])[0])).toContain('steel');
    expect(bom.totalMassKg).toBeCloseTo(0.0314, 9);
    expect(bom.rowsWithoutDensity).toEqual(['brx']);
    expect(bom.summary).toContain('total mass 0.0314000 kg (1 rows without density)');
    expectPure(doc, () => execute(doc, 'bill_of_materials', {}));
  });

  it('gives null mass and lists the row when the part has no material', () => {
    const bom = bomOf(assembly(false));
    expect(bom.rows.every((r) => r['unitMassKg'] === null && r['totalMassKg'] === null)).toBe(true);
    expect(bom.rows[0]?.['massReason']).toContain('without a material');
    expect(bom.rowsWithoutDensity.sort()).toEqual(['blk', 'brx']);
    expect(bom.totalMassKg).toBe(0);
    expect(bom.summary).toContain('total mass 0.00000 kg (2 rows without density)');
  });
});
