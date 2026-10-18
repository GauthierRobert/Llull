import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';

const metreDoc = (): CadDocument => ({ ...createEmptyDocument(), units: 'm' });
const warningsOf = (data: unknown): string[] => (data as { warnings: string[] }).warnings;

describe('create_material density unit guard', () => {
  it('metre document with a bare 7850 warns and names kg/m3', () => {
    const doc = metreDoc();
    const result = execute(doc, 'create_material', { name: 'steel', density: 7850 });
    expect(result.document.materials['steel']?.density).toBe(7850);
    expect(result.summary).toContain('WARNING');
    expect(result.summary).toContain('0.00785 g/cm³');
    expect(result.summary).toContain('did you mean 7850 kg/m³');
    expect(result.summary).toContain('densityUnit "kg/m^3"');
    expect(warningsOf(result.data)).toHaveLength(1);
    expect(doc.materials['steel']).toBeUndefined();
  });

  it('densityUnit kg/m3 stores correctly with no warning and prints both units', () => {
    const result = execute(metreDoc(), 'create_material', { name: 'steel', density: 7850, densityUnit: 'kg/m^3' });
    expect(result.document.materials['steel']?.density).toBeCloseTo(7_850_000, 3);
    expect(result.summary).not.toContain('WARNING');
    expect(result.summary).toContain('7.85 g/cm³ (7850 kg/m³)');
    expect(warningsOf(result.data)).toEqual([]);
  });

  it('mm document 0.00785 is plausible', () => {
    const result = execute({ ...createEmptyDocument(), units: 'mm' }, 'create_material', { name: 'steel', density: 0.00785 });
    expect(result.summary).not.toContain('WARNING');
    expect(result.summary).toContain('7.85 g/cm³ (7850 kg/m³)');
  });

  it('foam density needs an explicit unit', () => {
    expect(execute(metreDoc(), 'create_material', { name: 'foam', density: 5 }).summary).toContain('WARNING');
    expect(execute(metreDoc(), 'create_material', { name: 'foam', density: 5, densityUnit: 'kg/m^3' }).summary).not.toContain('WARNING');
  });

  it('too-dense value without a plausible reading still warns', () => {
    const result = execute(metreDoc(), 'create_material', { name: 'x', density: 1e-12 });
    expect(result.summary).toContain('check the unit');
  });

  it('invalid density stays a no-op', () => {
    const result = execute(metreDoc(), 'create_material', { name: 'x', density: -1 });
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('failed');
  });
});

describe('legacy material density on read paths', () => {
  const withBox = (density: number): CadDocument => {
    let doc = metreDoc();
    doc = execute(doc, 'create_material', { name: 'steel', density }).document;
    const added = execute(doc, 'add_box', { size: [1, 1, 1] });
    const id = added.affected[0] ?? '';
    return execute(added.document, 'assign_material', { materialName: 'steel', entityIds: [id] }).document;
  };
  const boxId = (doc: CadDocument): string => doc.order[0] ?? '';

  it('mass_properties warns on an implausible legacy density', () => {
    const doc = withBox(7850);
    const result = execute(doc, 'mass_properties', { entityId: boxId(doc) });
    expect(result.summary).toContain('WARNING');
    expect(result.summary).toContain('0.00785 g/cm³');
    expect((result.data as { densityWarnings: string[] }).densityWarnings).toHaveLength(1);
  });

  it('mass_properties is quiet on a plausible density', () => {
    const doc = withBox(7_850_000);
    const result = execute(doc, 'mass_properties', { entityId: boxId(doc) });
    expect(result.summary).not.toContain('WARNING');
    expect(result.summary).toContain('7.85 g/cm³ (7850 kg/m³)');
    expect(result.data).not.toHaveProperty('densityWarnings');
  });

  it('check_materials reports MAT_DENSITY_IMPLAUSIBLE', () => {
    const result = execute(withBox(7850), 'check_materials', {});
    expect(result.summary).toContain('MAT_DENSITY_IMPLAUSIBLE');
  });
});
