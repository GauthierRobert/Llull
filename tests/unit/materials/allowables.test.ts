import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CadDocument } from '@core/model/types';
import { call, dataOf, mmDocument, SOURCE, step } from './support';

const PACK = 'docs/aerospace/08-materials-standards-libraries/validation/expected_results.json';
const pack = JSON.parse(readFileSync(PACK, 'utf8')) as { agentFirst: { id: string; expected: Record<string, unknown>[] }[] };
const vc23 = pack.agentFirst.find((entry) => entry.id === 'VC-MAT-23')?.expected ?? [];

const record = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  designation: '7075',
  specs: [],
  licence: 'public-domain-us-gov',
  exportMarking: { regime: 'none' },
  ...extra,
});
const value = (material: string, extra: Record<string, unknown>): Record<string, unknown> => ({ material, source: SOURCE, ...extra });
const withRecord = (id: string, extra: Record<string, unknown> = {}): CadDocument =>
  step(mmDocument(), 'define_material_record', record(id, extra));
const ask = (doc: CadDocument, extra: Record<string, unknown>): ReturnType<typeof call> =>
  call(doc, 'get_material_allowable', { material: 'r', property: 'Ftu', ...extra });

describe('get_material_allowable', () => {
  it('VC-MAT-05: A and B are not substituted by S; S is returned with its basis and review flag', () => {
    const doc = step(
      withRecord('r'),
      'set_material_property',
      value('r', { id: 'ftu.s', property: 'Ftu', value: 60, unit: 'ksi', basis: 'S' }),
    );
    for (const basis of ['A', 'B']) {
      const refused = ask(doc, { basis });
      expect(refused.rejected).toBe(true);
      expect(refused.error).toMatchObject({ code: 'MAT_ALLOWABLE_NOT_AVAILABLE', ids: ['r'] });
      expect(refused.error?.remediation).toContain('never substituted');
      expect(dataOf(refused)).toMatchObject({ available: false, candidates: [{ modelId: 'ftu.s', basis: 'S', value: 60, unit: 'ksi' }] });
      expect(refused.document).toBe(doc);
    }
    const found = ask(doc, { basis: 'S' });
    expect(found.rejected).toBeUndefined();
    expect(dataOf(found)).toMatchObject({
      available: true,
      value: 60,
      unit: 'ksi',
      basis: 'S',
      unverified: false,
      unverifiedReasons: [],
      reviewRequired: true,
      provenance: SOURCE,
    });
    expect(found.document).toBe(doc);
  });

  it('VC-MAT-05: forCertification refuses a superseded source; plain queries warn', () => {
    const doc = step(
      withRecord('r', { superseded: { by: 'MMPDS', note: 'MIL-HDBK-5J cancelled 2003' } }),
      'set_material_property',
      value('r', { property: 'Ftu', value: 60, unit: 'ksi', basis: 'S' }),
    );
    const refused = ask(doc, { basis: 'S', forCertification: true });
    expect(refused.error).toMatchObject({ code: 'MAT_SOURCE_SUPERSEDED', ids: ['r'] });
    expect(dataOf(refused)).toMatchObject({ available: false, code: 'MAT_SOURCE_SUPERSEDED', superseded: { by: 'MMPDS' } });
    const plain = dataOf(ask(doc, { basis: 'S' }));
    expect(plain['available']).toBe(true);
    expect((plain['warnings'] as { code: string }[]).map((w) => w.code)).toContain('MAT_SOURCE_SUPERSEDED');
  });

  it('VC-MAT-23: a typical value is returned unverified and review-required, and refused for certification', () => {
    const doc = step(withRecord('r'), 'set_material_property', value('r', { property: 'Ftu', value: 83, unit: 'ksi', basis: 'typical' }));
    const [plainRow, certRow] = vc23;
    const plain = dataOf(ask(doc, { basis: 'typical', unit: 'MPa' }));
    expect(Math.abs((plain['value'] as number) / (plainRow?.['valueMPa'] as number) - 1)).toBeLessThan(2e-3);
    expect(plain).toMatchObject({
      unit: 'MPa',
      basis: 'typical',
      unverified: true,
      unverifiedReasons: ['basis typical'],
      reviewRequired: true,
    });
    expect((plain['warnings'] as { code: string }[]).map((w) => w.code)).toContain('MAT_VALUE_UNVERIFIED');
    const refused = ask(doc, { basis: 'typical', forCertification: true });
    expect(refused.error?.code).toBe(certRow?.['code']);
    expect(dataOf(refused)).toMatchObject({ available: false, code: 'MAT_VALUE_UNVERIFIED', reviewRequired: true });
  });

  describe('keys: thickness, e/D, direction, preferred', () => {
    let doc = withRecord('r');
    for (const [id, min, max, ftu] of [
      ['thin', 0.02, 0.128, 65],
      ['thick', 0.129, 0.249, 64],
    ] as const)
      doc = step(
        doc,
        'set_material_property',
        value('r', { id, property: 'Ftu', value: ftu, unit: 'ksi', basis: 'A', direction: 'L', thickness: { min, max, unit: 'in' } }),
      );
    for (const [id, ratio, bru] of [
      ['bru15', 1.5, 100],
      ['bru20', 2, 130],
    ] as const)
      doc = step(
        doc,
        'set_material_property',
        value('r', { id, property: 'Fbru', value: bru, unit: 'ksi', basis: 'A', direction: 'L', edOverD: ratio }),
      );

    it('picks the thickness range that contains the query, in any length unit', () => {
      expect(dataOf(ask(doc, { basis: 'A', direction: 'L', thickness: { value: 0.1, unit: 'in' } }))).toMatchObject({
        value: 65,
        modelId: 'thin',
      });
      expect(dataOf(ask(doc, { basis: 'A', direction: 'L', thickness: { value: 3, unit: 'mm' } }))).toMatchObject({ modelId: 'thin' });
      expect(dataOf(ask(doc, { basis: 'A', direction: 'L', thickness: { value: 0.2, unit: 'in' } }))).toMatchObject({
        value: 64,
        modelId: 'thick',
      });
    });

    it('does not answer outside the ranges, without a thickness, or for another direction', () => {
      for (const extra of [{ thickness: { value: 0.5, unit: 'in' } }, {}, { thickness: { value: 0.1, unit: 'in' }, direction: 'LT' }]) {
        const refused = ask(doc, { basis: 'A', direction: 'L', ...extra });
        expect(refused.error?.code).toBe('MAT_ALLOWABLE_NOT_AVAILABLE');
        expect((dataOf(refused)['candidates'] as unknown[]).length).toBe(2);
      }
    });

    it('matches the e/D of a bearing value exactly', () => {
      expect(
        dataOf(call(doc, 'get_material_allowable', { material: 'r', property: 'Fbru', basis: 'A', direction: 'L', edOverD: 2 })),
      ).toMatchObject({ value: 130, condition: { edOverD: 2 } });
      expect(call(doc, 'get_material_allowable', { material: 'r', property: 'Fbru', basis: 'A', direction: 'L' }).error?.code).toBe(
        'MAT_ALLOWABLE_NOT_AVAILABLE',
      );
      expect(
        call(doc, 'get_material_allowable', { material: 'r', property: 'Fbru', basis: 'A', direction: 'L', edOverD: 1.75 }).error?.code,
      ).toBe('MAT_ALLOWABLE_NOT_AVAILABLE');
    });
  });

  it('is ambiguous without a preferred value and answers the preferred one otherwise; isotropic means no direction', () => {
    let doc = withRecord('r');
    doc = step(doc, 'set_material_property', value('r', { id: 'a', property: 'E', value: 10.3, unit: 'Msi', basis: 'typical' }));
    doc = step(doc, 'set_material_property', value('r', { id: 'b', property: 'E', value: 10.4, unit: 'Msi', basis: 'typical' }));
    const ambiguous = call(doc, 'get_material_allowable', { material: 'r', property: 'E', basis: 'typical', direction: 'isotropic' });
    expect(ambiguous.error?.code).toBe('MAT_ALLOWABLE_AMBIGUOUS');
    expect(dataOf(ambiguous)['candidates']).toHaveLength(2);
    doc = step(
      doc,
      'set_material_property',
      value('r', { id: 'b', property: 'E', value: 10.4, unit: 'Msi', basis: 'typical', preferred: true, replace: true }),
    );
    expect(dataOf(call(doc, 'get_material_allowable', { material: 'r', property: 'E', basis: 'typical' }))).toMatchObject({
      value: 10.4,
      modelId: 'b',
    });
  });

  describe('VC-MAT-16: temperature tables', () => {
    const doc = step(
      step(withRecord('r'), 'set_material_property', value('r', { id: 'rt', property: 'Ftu', value: 60, unit: 'ksi', basis: 'B' })),
      'set_material_property',
      value('r', {
        id: 'hot',
        property: 'Ftu',
        unit: 'ksi',
        temperature: {
          mode: 'percentOfRT',
          temperatureUnit: 'degF',
          points: [
            [70, 100],
            [300, 80],
            [500, 50],
          ],
        },
      }),
    );

    it('interpolates linearly: 400 degF is 65 % of 60 ksi', () => {
      const data = dataOf(ask(doc, { basis: 'B', temperature: { value: 400, unit: 'degF' } }));
      expect(Math.abs((data['value'] as number) / 39 - 1)).toBeLessThan(1e-12);
      expect(data).toMatchObject({ unit: 'ksi', modelId: 'hot', baseModelId: 'rt', reviewRequired: true });
      expect(data['baseProvenance']).toEqual(SOURCE);
      expect(
        Math.abs(
          (dataOf(ask(doc, { basis: 'B', temperature: { value: ((400 - 32) * 5) / 9, unit: 'degC' }, unit: 'MPa' }))['value'] as number) /
            (39 * 6.894757293168361) -
            1,
        ),
      ).toBeLessThan(1e-9);
    });

    it('answers the room-temperature value without a temperature, and refuses outside the table', () => {
      expect(dataOf(ask(doc, { basis: 'B' }))).toMatchObject({ value: 60, modelId: 'rt' });
      const refused = ask(doc, { basis: 'B', temperature: { value: 600, unit: 'degF' } });
      expect(refused.error).toMatchObject({ code: 'MAT_TEMPERATURE_OUT_OF_RANGE', ids: ['r'], paths: ['at.T'] });
      expect(refused.error?.remediation).toContain('extrapolat');
      expect(dataOf(refused)).toMatchObject({ available: false, code: 'MAT_TEMPERATURE_OUT_OF_RANGE' });
      expect(ask(doc, { basis: 'B', temperature: { value: 400, unit: 'furlong' } }).error?.code).toBe('MAT_UNIT_INVALID');
    });

    it('has no temperature answer for a value that was only given at room temperature', () => {
      const flat = step(withRecord('r'), 'set_material_property', value('r', { property: 'Ftu', value: 60, unit: 'ksi', basis: 'B' }));
      expect(ask(flat, { basis: 'B', temperature: { value: 400, unit: 'degF' } }).error?.code).toBe('MAT_ALLOWABLE_NOT_AVAILABLE');
    });
  });

  it('refuses an unknown material, and reports a bad output unit', () => {
    const doc = withRecord('r');
    expect(call(doc, 'get_material_allowable', { material: 'ghost', property: 'Ftu', basis: 'A' }).error).toMatchObject({
      code: 'MAT_RECORD_NOT_FOUND',
      paths: ['material'],
    });
    const withValue = step(doc, 'set_material_property', value('r', { property: 'E', value: 10.3, unit: 'Msi', basis: 'company' }));
    expect(call(withValue, 'get_material_allowable', { material: 'r', property: 'E', basis: 'company', unit: 'g' }).error?.code).toBe(
      'MAT_UNIT_DIMENSION',
    );
    expect(dataOf(call(withValue, 'get_material_allowable', { material: 'r', property: 'E', basis: 'company' }))).toMatchObject({
      unverified: false,
    });
  });
});
