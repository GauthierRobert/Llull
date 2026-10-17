import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { thermomechMaterialCards, thermomechSections } from '@cae/thermomech/deck';
import { cteModel } from '../../physics/thermomech/thermomechFixtures';
import { deckContext, thermoFixture } from './fixtures';

const text = (sections: ReturnType<typeof thermomechSections>): string => ('text' in sections ? sections.text : JSON.stringify(sections));
const dataLines = (value: string): string[] => value.split('\n').filter((line) => line !== '' && !line.startsWith('**'));

describe('thermomech deck', () => {
  it('writes the constant secant expansion of a thermalStrain model about the reference temperature', () => {
    const fixture = thermoFixture();
    const cards = text(thermomechMaterialCards(deckContext(fixture), fixture.boxId));
    expect(dataLines(cards)).toEqual(['*EXPANSION, ZERO=20', '0.000012']);
    expect(cards).toMatch(/thermalStrain model/);
    expect(cards).toMatch(/model sha256 [0-9a-f]{64}/);
  });

  it('writes the step: initial temperature, mechanical lines, one *TEMPERATURE line per node, outputs', () => {
    const fixture = thermoFixture();
    expect(text(thermomechSections(deckContext(fixture)))).toBe(
      [
        `** thermo-mechanical analysis ${fixture.analysisId}: T_ref 20 degC; field uniform 120 degC`,
        '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
        '1, 20',
        '2, 20',
        '3, 20',
        '4, 20',
        '5, 20',
        '*STEP',
        '*STATIC',
        '*CLOAD, OP=NEW',
        '*DLOAD, OP=NEW',
        '*TEMPERATURE',
        '1, 120',
        '2, 120',
        '3, 120',
        '4, 120',
        '5, 120',
        '*NODE FILE',
        'U, NT',
        '*EL FILE',
        'S, E, THE',
        '*END STEP',
        '',
      ].join('\n'),
    );
  });

  it('is byte-identical for identical inputs', () => {
    const fixture = thermoFixture({
      field: { kind: 'expression', expression: '20 + x / 3', coordinatesUnit: 'mm', temperatureUnit: 'degC' },
    });
    expect(text(thermomechSections(deckContext(fixture)))).toBe(text(thermomechSections(deckContext(fixture))));
  });

  it('evaluates an expression per node with coordinates in the declared unit and converts the temperature unit', () => {
    const fixture = thermoFixture({ field: { kind: 'expression', expression: '300 + x', coordinatesUnit: 'm', temperatureUnit: 'K' } });
    const lines = dataLines(text(thermomechSections(deckContext(fixture)))).filter((line) => /^\d, [\d.]+$/.test(line));
    // nodes are in mm: x = 10 mm = 0.01 m -> 300.01 K = 26.86 degC; node 1 at x = 0 -> 300 K = 26.85 degC
    const temperatures = lines.slice(5).map((line) => Number(line.split(', ')[1]));
    expect(temperatures[0]).toBeCloseTo(26.85, 10);
    expect(temperatures[1]).toBeCloseTo(26.86, 10);
  });

  it('refuses a non-finite expression with the node count (TMC_FIELD_INVALID)', () => {
    const fixture = thermoFixture({ field: { kind: 'expression', expression: '1 / x', coordinatesUnit: 'mm', temperatureUnit: 'degC' } });
    const sections = thermomechSections(deckContext(fixture));
    expect(sections).toMatchObject({ code: 'TMC_FIELD_INVALID' });
    expect(JSON.stringify(sections)).toContain('3 of 5 node(s)');
  });

  it('writes a temperature-dependent secant table from an instantaneous cte table, exact trapezoid', () => {
    const model = cteModel({
      kind: 'table1d',
      variable: 'T',
      interpolation: 'linear',
      points: [
        [273.15, 1e-5],
        [473.15, 2e-5],
      ],
    });
    const fixture = thermoFixture({
      model: { ...model, variables: [{ variable: 'T', unit: 'K' }], validity: [{ variable: 'T', unit: 'K', data: [273.15, 473.15] }] },
    });
    const withBasis = execute(fixture.doc, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      source: { kind: 'uniform', value: { value: 120, unit: 'degC' } },
      cteBasis: { mat: { kind: 'instantaneous' } },
    });
    const cards = text(thermomechMaterialCards(deckContext({ ...fixture, doc: withBasis.document }), fixture.boxId));
    // alpha_i(T) = 1e-5 + 5e-8 (T - 273.15); secant about 293.15 K at 393.15 K = alpha_i at the midpoint 343.15 K = 1e-5 + 5e-8 * 70
    const rows = dataLines(cards).slice(1);
    expect(rows.length).toBeGreaterThan(1);
    const last = rows[rows.length - 1]?.split(', ').map(Number) ?? [];
    expect(last[1]).toBeCloseTo(120, 9);
    expect(last[0]).toBeCloseTo(1e-5 + 5e-8 * 70, 14);
  });

  it('re-references a secant cte model stated about another reference temperature', () => {
    const fixture = thermoFixture({ model: { ...cteModel({ kind: 'constant', value: 1e-5 }), variables: [{ variable: 'T', unit: 'K' }] } });
    const stated = execute(fixture.doc, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      source: { kind: 'uniform', value: { value: 120, unit: 'degC' } },
      cteBasis: { mat: { kind: 'secant', referenceTemperature: { value: 20, unit: 'degC' } } },
    });
    const cards = text(thermomechMaterialCards(deckContext({ ...fixture, doc: stated.document }), fixture.boxId));
    expect(dataLines(cards)).toEqual(['*EXPANSION, ZERO=20', '0.00001']);
    expect(cards).toMatch(/secant, reference 293\.15 K/);
  });

  it('refuses a cte model of unstated basis (TMC_CTE_BASIS_UNKNOWN) and a material without cte (TMC_MATERIAL_NO_CTE)', () => {
    const unstated = thermoFixture({
      model: { ...cteModel({ kind: 'constant', value: 1e-5 }), variables: [{ variable: 'T', unit: 'K' }] },
    });
    expect(thermomechMaterialCards(deckContext(unstated), unstated.boxId)).toMatchObject({ code: 'TMC_CTE_BASIS_UNKNOWN' });
    const bare = thermoFixture({ model: null });
    expect(thermomechMaterialCards(deckContext(bare), bare.boxId)).toMatchObject({ code: 'TMC_MATERIAL_NO_CTE' });
  });

  it('refuses a model validity range the field leaves (TMC_PROPERTY_OUT_OF_RANGE) and a missing field', () => {
    const hot = thermoFixture({ field: { kind: 'uniform', value: { value: 500, unit: 'degC' } } });
    expect(thermomechMaterialCards(deckContext(hot), hot.boxId)).toMatchObject({ code: 'TMC_PROPERTY_OUT_OF_RANGE' });
    const none = thermoFixture({ field: null });
    expect(thermomechSections(deckContext(none))).toMatchObject({ code: 'TMC_FIELD_SOURCE_INVALID' });
  });

  it('refuses a case that is not thermo_static (THM_CASE_TYPE) and a part without a material', () => {
    const fixture = thermoFixture();
    const created = execute(fixture.doc, 'create_analysis', { name: 'S', analysisType: 'static' });
    const id = created.affected[0] ?? '';
    const context = deckContext({ ...fixture, doc: created.document, analysisId: id });
    expect(thermomechSections(context)).toMatchObject({ code: 'THM_CASE_TYPE' });
    expect(thermomechMaterialCards(context, fixture.boxId)).toMatchObject({ code: 'THM_CASE_TYPE' });
    const unassigned = execute(fixture.doc, 'add_box', { size: [1, 1, 1] });
    expect(thermomechMaterialCards(deckContext({ ...fixture, doc: unassigned.document }), unassigned.affected[0] ?? '')).toMatchObject({
      code: 'TMC_MATERIAL_NO_CTE',
    });
  });
});
