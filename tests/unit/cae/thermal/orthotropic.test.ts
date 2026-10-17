import { describe, expect, it } from 'vitest';
import { buildDeckContext } from '@cae/decks/context';
import { checkThermalItems } from '@cae/thermal/check';
import { thermalMaterialCards } from '@cae/thermal/deck';
import { isOrthotropic, orthotropicRows, propertyTable, type PropertyRequest } from '@cae/thermal/material';
import type { CadDocument, Material } from '@core/model/types';
import { must, thermalFixture, twoTetMesh, type ThermalFixture } from './fixtures';

const SOURCE = { citation: 'synthetic model for the orthotropic tests' };

const constantK = (direction: string, value: number): Record<string, unknown> => ({
  id: `k_${direction}`,
  property: 'k',
  unit: 'W/(m*K)',
  direction,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis: 'company',
  source: SOURCE,
});

const tableK = (direction: string, points: readonly (readonly [number, number])[]): Record<string, unknown> => ({
  id: `k_${direction}`,
  property: 'k',
  unit: 'W/(m*K)',
  direction,
  variables: [{ variable: 'T', unit: 'degC' }],
  validity: [{ variable: 'T', unit: 'degC', data: [points[0]?.[0] ?? 0, points[points.length - 1]?.[0] ?? 0] }],
  form: { kind: 'table1d', variable: 'T', points, interpolation: 'linear' },
  basis: 'company',
  source: SOURCE,
});

/** Fixture whose material has no isotropic k, plus the given directional k models. */
function orthoFixture(models: readonly Record<string, unknown>[]): ThermalFixture {
  const fixture = thermalFixture({ k: null });
  let doc: CadDocument = fixture.doc;
  for (const model of models) doc = must(doc, 'define_property_model', { material: 'steel', model }).document;
  return { ...fixture, doc };
}

const request = (fixture: ThermalFixture): PropertyRequest => ({
  materialName: 'steel',
  material: fixture.doc.materials['steel'] as Material,
  documentUnit: 'm',
  property: 'k',
  scale: 'degC',
  unitSystem: 'N-m-kg-s',
  required: [20, 80],
});

describe('orthotropic conductivity (k models of direction 1 / 2 / 3)', () => {
  it('combines three constant directions into one row and writes *CONDUCTIVITY, TYPE=ORTHO', () => {
    const fixture = orthoFixture([constantK('1', 10), constantK('2', 20), constantK('3', 30)]);
    expect(isOrthotropic(fixture.doc.materials['steel'] as Material)).toBe(true);
    const table = propertyTable(request(fixture));
    if ('code' in table) throw new Error(table.message);
    expect(table.orthotropic).toHaveLength(3);
    expect(orthotropicRows(table)).toEqual([[10, 20, 30]]);
    const ctx = buildDeckContext(fixture.doc, fixture.analysisId, twoTetMesh(fixture));
    const cards = ctx === null ? null : thermalMaterialCards(ctx, fixture.boxId);
    if (cards === null || !('text' in cards)) throw new Error(JSON.stringify(cards));
    expect(cards.text).toContain('*CONDUCTIVITY, TYPE=ORTHO\n10, 20, 30\n');
    expect(cards.text).toContain('** k direction 2 (document Y axis)');
    expect(cards.text).not.toContain('\n*CONDUCTIVITY\n');
  });

  it('merges a temperature table with constants on the union grid: rows [k1, k2(T), k3, T]', () => {
    const fixture = orthoFixture([
      constantK('1', 10),
      tableK('2', [
        [0, 20],
        [50, 30],
        [100, 50],
      ]),
      constantK('3', 30),
    ]);
    const table = propertyTable(request(fixture));
    if ('code' in table) throw new Error(table.message);
    const rows = orthotropicRows(table);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const [k1, k2, k3, temperature] of rows) {
      expect([k1, k3]).toEqual([10, 30]);
      const expected = (temperature ?? 0) <= 50 ? 20 + 0.2 * (temperature ?? 0) : 30 + 0.4 * ((temperature ?? 0) - 50);
      expect(k2).toBeCloseTo(Math.min(Math.max(expected, 20), 50), 9);
    }
    expect(table.range).not.toBeNull();
  });

  it('refuses a material with k models for only some of the directions (THM_MATERIAL_K_ORTHO) and reports it in check_thermal', () => {
    const fixture = orthoFixture([constantK('1', 10), constantK('3', 30)]);
    expect(propertyTable(request(fixture))).toMatchObject({ code: 'THM_MATERIAL_K_ORTHO' });
    const ctx = buildDeckContext(fixture.doc, fixture.analysisId, twoTetMesh(fixture));
    expect(ctx === null ? null : thermalMaterialCards(ctx, fixture.boxId)).toMatchObject({ code: 'THM_MATERIAL_K_ORTHO' });
    expect(checkThermalItems(fixture.doc, fixture.analysisId).map((item) => item.code)).toContain('THM_MATERIAL_K_ORTHO');
  });

  it('refuses a rotated part (the directions are the document axes) in the deck and in check_thermal; an isotropic material is unaffected', () => {
    const fixture = orthoFixture([constantK('1', 10), constantK('2', 20), constantK('3', 30)]);
    const rotated = must(fixture.doc, 'rotate_entity', { id: fixture.boxId, delta: [0, 0, 0.5] }).document;
    expect(rotated.entities[fixture.boxId]?.rotation.some((angle) => angle !== 0)).toBe(true);
    const ctx = buildDeckContext(rotated, fixture.analysisId, twoTetMesh(fixture));
    expect(ctx === null ? null : thermalMaterialCards(ctx, fixture.boxId)).toMatchObject({ code: 'THM_MATERIAL_ORTHO_ROTATED' });
    expect(checkThermalItems(rotated, fixture.analysisId).map((item) => item.code)).toContain('THM_MATERIAL_ORTHO_ROTATED');
    const isotropic = thermalFixture();
    const turned = must(isotropic.doc, 'rotate_entity', { id: isotropic.boxId, delta: [0, 0, 0.5] }).document;
    expect(checkThermalItems(turned, isotropic.analysisId).map((item) => item.code)).not.toContain('THM_MATERIAL_ORTHO_ROTATED');
  });
});
