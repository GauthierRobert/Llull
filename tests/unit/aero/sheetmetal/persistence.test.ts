import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { derivedEntityIds } from '@core/plugins/host';
import { apply, bracket, data, folded, meshVolume, ok } from './helpers';

describe('persistence of sheet-metal parts', () => {
  it('omits the derived folded solid from the file and re-derives it on load', () => {
    const { doc, part } = bracket();
    const circle = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = apply(circle.document, 'add_sheet_cutout', { id: part, face: { near: [10, 25, 0] }, profileId: circle.affected[0] });
    expect(derivedEntityIds(cut).has(part)).toBe(true);
    const text = serializeDocument(cut);
    const saved = JSON.parse(text) as { document: { entities: Record<string, unknown>; order: string[]; sheetMetal: unknown } };
    expect(saved.document.entities[part]).toBeUndefined();
    expect(saved.document.sheetMetal).toBeDefined();
    const loaded = deserializeDocument(text);
    expect(loaded.sheetMetal).toEqual(cut.sheetMetal);
    expect(folded(loaded, part).brep).toEqual(folded(cut, part).brep);
    expect(meshVolume(loaded, part)).toBeCloseTo(meshVolume(cut, part), 9);
    expect(loaded.order.filter((id) => id === part)).toHaveLength(1);
    expect(data<{ extents: number[] }>(loaded, 'flat_pattern', { id: part }).extents[0]).toBeCloseTo(65.845662983, 6);
    expect(serializeDocument(loaded)).toBe(text);
  });

  it('keeps a document with only rules and radius rows (no parts)', () => {
    const rule = apply(bracket({}, false).doc, 'import_bend_radius_table', {
      rows: [{ material: 'A', temper: 'T', thickness: 1, minInsideRadius: 2, units: 'mm', bendAngle: 90, source: 's' }],
    });
    const loaded = deserializeDocument(serializeDocument(rule));
    expect(loaded.sheetMetal?.radiusTable).toHaveLength(1);
  });

  it('rejects a file whose sheetMetal slice is malformed', () => {
    const { doc, part } = bracket();
    const broken = (edit: (model: Record<string, unknown>) => void): string => {
      const parsed = JSON.parse(serializeDocument(doc)) as { document: { sheetMetal: Record<string, unknown> } };
      edit(parsed.document.sheetMetal);
      return JSON.stringify(parsed);
    };
    const errorOf = (json: string): string => {
      try {
        deserializeDocument(json);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    expect(
      errorOf(
        broken(
          (model) => ((model['rules'] as Record<string, { thickness: number }>)[doc.sheetMetal?.parts[part]?.rule ?? '']!.thickness = -1),
        ),
      ),
    ).toContain('thickness');
    expect(
      errorOf(
        broken(
          (model) =>
            (model['radiusTable'] = [
              {
                material: 'A',
                temper: 'T',
                thickness: 1,
                minInsideRadius: 1,
                units: 'mm',
                bendAngle: 90,
                source: '',
                verification: 'verified',
              },
            ]),
        ),
      ),
    ).toContain('source');
    expect(errorOf(broken((model) => delete model['parts']))).toContain('sheetMetal');
    expect(errorOf(broken((model) => ((model['parts'] as Record<string, { root: string }>)[part]!.root = 'zz')))).toContain('root');
    expect(errorOf(broken((model) => ((model['parts'] as Record<string, { order: string[] }>)[part]!.order = ['f1'])))).toContain('order');
    expect(
      errorOf(
        broken(
          (model) => ((model['parts'] as Record<string, { nodes: Record<string, { angle: unknown }> }>)[part]!.nodes['b1']!.angle = 'x'),
        ),
      ),
    ).toContain('bend');
    expect(errorOf(JSON.stringify(JSON.parse(serializeDocument(doc))))).toBe('');
  });

  it('rejects a file whose part names a missing rule', () => {
    const { doc, part } = bracket();
    const parsed = JSON.parse(serializeDocument(doc)) as { document: { sheetMetal: { rules: Record<string, unknown> } } };
    parsed.document.sheetMetal.rules = {};
    expect(() => deserializeDocument(JSON.stringify(parsed))).toThrow(/rule/);
    expect(part).toBeDefined();
  });
});

describe('derivation guard', () => {
  it('refuses edits and deletion of the folded solid', () => {
    const { doc, part } = bracket();
    const deleted = execute(doc, 'delete_entities', { ids: [part] });
    expect(deleted.rejected).toBe(true);
    expect(deleted.error?.code).toBe('CMD_DERIVED_GEOMETRY');
    expect(deleted.document).toBe(doc);
    expect(deleted.summary).toContain('folded solid');
    const moved = execute(doc, 'move_entities', { ids: [part], offset: [5, 0, 0] });
    expect(moved.rejected).toBe(true);
  });

  it('allows unrelated commands and the sheet-metal commands themselves', () => {
    const { doc, part } = bracket();
    const unrelated = execute(doc, 'draw_rectangle', { width: 5, height: 5, position: [100, 0, 0] });
    expect(unrelated.rejected).toBeUndefined();
    const again = execute(unrelated.document, 'materialize_flat_pattern', { id: part });
    expect(again.rejected).toBeUndefined();
    expect(again.document.entities[part]).toBe(unrelated.document.entities[part]);
  });
});

describe('material and layer of a sheet-metal part', () => {
  const prepared = (): { doc: CadDocument; part: string; layerId: string } => {
    const built = bracket();
    const withMaterial = apply(built.doc, 'create_material', {
      name: 'al2024',
      density: 0.00278,
      color: '#b0b0b0',
      metalness: 1,
      roughness: 0.4,
    });
    const layered = ok(withMaterial, 'add_layer', { name: 'SKIN' });
    return { doc: layered.document, part: built.part, layerId: layered.affected[0] as string };
  };

  it('assign_material on the derived solid points to set_sheet_metal_material', () => {
    const { doc, part } = prepared();
    const refused = execute(doc, 'assign_material', { materialName: 'al2024', entityIds: [part] });
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain('set_sheet_metal_material');
  });

  it('the part carries the material and layer: mass works, re-derivation and save / load keep them', () => {
    const { doc, part, layerId } = prepared();
    const assigned = ok(doc, 'set_sheet_metal_material', { id: part, materialName: 'al2024', layerId });
    expect(assigned.affected).toEqual([part]);
    expect(folded(assigned.document, part)).toMatchObject({ materialId: 'al2024', layerId });
    const mass = data<{ mass: number }>(assigned.document, 'mass_properties', { entityId: part });
    expect(mass.mass).toBeCloseTo(meshVolume(assigned.document, part) * 0.00278, 6);
    const circle = ok(assigned.document, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = apply(circle.document, 'add_sheet_cutout', { id: part, face: { near: [10, 25, 0] }, profileId: circle.affected[0] });
    expect(folded(cut, part)).toMatchObject({ materialId: 'al2024', layerId });
    const loaded = deserializeDocument(serializeDocument(assigned.document));
    expect(folded(loaded, part)).toMatchObject({ materialId: 'al2024', layerId });
  });

  it('refuses an unknown part, material or layer without changing the document', () => {
    const { doc, part } = prepared();
    const refuse = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'set_sheet_metal_material', params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.error?.code).toBe(code);
    };
    refuse({ id: 'nope', materialName: 'al2024' }, 'FTR_PART_NOT_FOUND');
    refuse({ id: part, materialName: 'unobtainium' }, 'FTR_PARAM_INVALID');
    refuse({ id: part, materialName: 'al2024', layerId: 'no-layer' }, 'FTR_PARAM_INVALID');
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty']) {
      refuse({ id: part, materialName: inherited }, 'FTR_PARAM_INVALID');
    }
  });
});
