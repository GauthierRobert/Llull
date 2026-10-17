/** bill_of_materials standard-part and material sections (08 MAT FR-MAT-16, VC-MAT-11) on the core alone: no fastener plugin involved. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { PartRef } from '@core/model/fasteners';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { expectPure } from '../../helpers/expectNoOp';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; ids: string[] } {
  const result = execute(doc, name, params);
  expect(result.rejected, result.summary).toBeUndefined();
  expect(result.document, result.summary).not.toBe(doc);
  return { doc: result.document, ids: result.affected };
}

/** A component of one 10 mm cube with a part reference, inserted `count` times. */
function withPart(doc: CadDocument, partRef: Record<string, unknown>, count: number, componentId: string): CadDocument {
  const cube = run(doc, 'add_box', { size: [10, 10, 10] });
  const created = run(cube.doc, 'create_component', { name: String(partRef['partNumber']), entityIds: cube.ids, componentId });
  let next: CadDocument = {
    ...created.doc,
    components: {
      ...created.doc.components,
      [componentId]: { ...created.doc.components[componentId]!, partRef: partRef as unknown as PartRef },
    },
  };
  for (let k = 1; k < count; k += 1) next = run(next, 'insert_instance', { componentId }).doc;
  return next;
}

const data = (doc: CadDocument, params: Record<string, unknown> = {}): Record<string, unknown> => {
  const result = execute(doc, 'bill_of_materials', params);
  return result.data as Record<string, unknown>;
};

describe('bill_of_materials standardParts', () => {
  it('groups instances by part number across components, with mass only when the geometry is not a placeholder', () => {
    let doc = withPart(
      createEmptyDocument(),
      { family: 'F', partNumber: 'PN-1', description: 'bolt', unitMass: { value: 12, unit: 'g' } },
      3,
      'c1',
    );
    doc = withPart(doc, { family: 'F', partNumber: 'PN-1', unitMass: { value: 12, unit: 'g' } }, 2, 'c2');
    doc = withPart(doc, { family: 'F', partNumber: 'PN-2', unitMass: { value: 5, unit: 'g' }, representative: true }, 1, 'c3');
    const result = data(doc);
    expect(result['standardParts']).toEqual([
      {
        partNumber: 'PN-1',
        family: 'F',
        description: 'bolt',
        count: 5,
        componentIds: ['c1', 'c2'],
        unitMass: { value: 12, unit: 'g' },
        totalMass: { value: 60, unit: 'g' },
      },
      { partNumber: 'PN-2', family: 'F', count: 1, componentIds: ['c3'], representative: true },
    ]);
    expect(result['totalInstances']).toBe(6);
    expect(execute(doc, 'bill_of_materials', {}).summary).toContain('Standard parts: PN-1 ×5, PN-2 ×1');
    expectPure(doc, () => execute(doc, 'bill_of_materials', { includeMaterials: true }));
  });

  it('keeps the legacy shape when no component has a partRef or the section is switched off', () => {
    const plain = run(run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).doc, 'create_component', {
      name: 'plain',
      entityIds: ['box-1.1'],
    });
    expect(Object.keys(data(plain.doc)).sort()).toEqual(['distinctComponents', 'rows', 'totalInstances']);
    const doc = withPart(createEmptyDocument(), { family: 'F', partNumber: 'PN-1' }, 1, 'c1');
    expect(Object.keys(data(doc, { includeStandardParts: false })).sort()).toEqual(['distinctComponents', 'rows', 'totalInstances']);
    expect((data(doc)['standardParts'] as Array<Record<string, unknown>>)[0]).toEqual({
      partNumber: 'PN-1',
      family: 'F',
      count: 1,
      componentIds: ['c1'],
    });
    expect(Object.keys(data(createEmptyDocument(), { includeStandardParts: true })).sort()).toEqual([
      'distinctComponents',
      'rows',
      'standardParts',
      'totalInstances',
    ]);
  });
});

describe('bill_of_materials materials', () => {
  function steelBlocks(): CadDocument {
    let doc = createEmptyDocument();
    doc = run(doc, 'create_material', { name: 'steel', density: 0.00785, color: '#888888', metalness: 1, roughness: 0.4 }).doc;
    const box = run(doc, 'add_box', { size: [10, 10, 10] });
    const cylinder = run(box.doc, 'add_cylinder', { radius: 5, height: 10 });
    const bare = run(cylinder.doc, 'add_box', { size: [1, 1, 1] });
    return run(bare.doc, 'assign_material', { entityIds: [...box.ids, ...cylinder.ids], materialName: 'steel' }).doc;
  }

  it('sums volume and mass per material (closed form), flags the legacy density unverified and counts unassigned solids', () => {
    const result = data(steelBlocks(), { includeMaterials: true });
    const [steel] = result['materials'] as Array<Record<string, unknown>>;
    const volume = 1000 + Math.PI * 25 * 10;
    expect(steel).toMatchObject({
      materialId: 'steel',
      solidCount: 2,
      volumeUnit: 'mm³',
      massUnit: 'g',
      volumeMethod: 'closed_form',
      unverified: true,
    });
    expect(steel?.['totalVolume']).toBeCloseTo(volume, 6);
    expect(steel?.['totalMass']).toBeCloseTo(volume * 0.00785, 6);
    expect(steel?.['totalMassKg']).toBeCloseTo((volume * 0.00785) / 1000, 9);
    expect(steel?.['unverifiedReasons']).toEqual(['provenance legacy']);
    expect(String(steel?.['densitySource'])).toContain('steel');
    expect(result['unassignedSolidCount']).toBe(1);
    expect(execute(steelBlocks(), 'bill_of_materials', { includeMaterials: true }).summary).toContain('steel');
  });

  it('counts the solids of a component once per instance, with the instance scale', () => {
    let doc = createEmptyDocument();
    doc = run(doc, 'create_material', { name: 'alu', density: 0.0027, color: '#cccccc', metalness: 1, roughness: 0.4 }).doc;
    const box = run(doc, 'add_box', { size: [10, 10, 10] });
    const assigned = run(box.doc, 'assign_material', { entityIds: box.ids, materialName: 'alu' });
    const component = run(assigned.doc, 'create_component', { name: 'cube', entityIds: box.ids, componentId: 'cube' });
    const second = run(component.doc, 'insert_instance', { componentId: 'cube', scale: [2, 1, 1], position: [50, 0, 0] });
    const [row] = data(second.doc, { includeMaterials: true })['materials'] as Array<Record<string, number>>;
    expect(row).toMatchObject({ solidCount: 2 });
    expect(row?.['totalVolume']).toBeCloseTo(3000, 6);
    expect(row?.['totalMass']).toBeCloseTo(3000 * 0.0027, 6);
  });

  it('reports a material that is not defined or whose density is refused, without a mass', () => {
    let doc = steelBlocks();
    doc = {
      ...doc,
      entities: Object.fromEntries(
        Object.entries(doc.entities).map(([id, entity]) => [
          id,
          entity.materialId === undefined ? entity : { ...entity, materialId: 'ghost' },
        ]),
      ),
    };
    const [ghost] = data(doc, { includeMaterials: true })['materials'] as Array<Record<string, unknown>>;
    expect(ghost).toMatchObject({ materialId: 'ghost', code: 'MAT_RECORD_NOT_FOUND', unverified: true });
    expect(ghost?.['totalMass']).toBeUndefined();
    const broken: CadDocument = { ...steelBlocks(), materials: { steel: { ...steelBlocks().materials['steel']!, density: -1 } } };
    const [refused] = data(broken, { includeMaterials: true })['materials'] as Array<Record<string, unknown>>;
    expect(refused).toMatchObject({ materialId: 'steel', code: 'MAT_DENSITY_INVALID' });
    expect(refused?.['totalMass']).toBeUndefined();
  });

  it('is omitted unless asked for and empty when nothing has a material', () => {
    expect(data(steelBlocks())['materials']).toBeUndefined();
    expect(data(createEmptyDocument(), { includeMaterials: true })).toMatchObject({ materials: [], unassignedSolidCount: 0 });
  });
});
