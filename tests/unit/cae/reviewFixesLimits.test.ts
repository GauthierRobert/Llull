/** Review fix 5: temperatures are bounded and the CTE table cannot be made to allocate without limit. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { MAX_PLAUSIBLE_TEMPERATURE, temperatureProblem } from '@cae/shared/quantity';
import { withCase } from '@cae/shared/access';
import { thermomechMaterialCards } from '@cae/thermomech/deck';
import { strainModel } from '../physics/thermomech/thermomechFixtures';
import { firstNonFinite, parseFrd } from '@cae/results/frdReader';
import { meshRequest } from '@cae/index';
import { caseIn, modelWithAnalysis } from './helpers';
import { deckContext, thermoFixture, type Fixture } from './thermomech/fixtures';

const withField = (fixture: Fixture, value: number, unit: string): Fixture => {
  const analysisCase = caseIn(fixture.doc, fixture.analysisId);
  const patched: AnalysisCase = {
    ...analysisCase,
    thermomech: { ...analysisCase.thermomech!, field: { kind: 'uniform', value: { value, unit } } },
  };
  return { ...fixture, doc: withCase(fixture.doc, patched) as CadDocument };
};

describe('temperatureProblem (review finding 5)', () => {
  it('rejects values below absolute zero and above the named ceiling', () => {
    expect(MAX_PLAUSIBLE_TEMPERATURE).toMatchObject({ value: 1e5, unit: 'K', source: 'llull guard' });
    expect(temperatureProblem({ value: -300, unit: 'degC' })).toMatch(/below absolute zero/);
    expect(temperatureProblem({ value: -1, unit: 'K' })).toMatch(/below absolute zero/);
    expect(temperatureProblem({ value: 1e10, unit: 'degC' })).toMatch(/llull guard/);
    expect(temperatureProblem({ value: 1e5 + 1, unit: 'K' })).toMatch(/ceiling/);
    expect(temperatureProblem({ value: 1e5, unit: 'K' })).toBeNull();
    expect(temperatureProblem({ value: 0, unit: 'K' })).toBeNull();
    expect(temperatureProblem({ value: 20, unit: 'degC' })).toBeNull();
  });

  it('set_temperature_field refuses a 1e10 degC uniform field', () => {
    const fixture = thermoFixture();
    const result = execute(fixture.doc, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      source: { kind: 'uniform', value: { value: 1e10, unit: 'degC' } },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('THM_UNITS_MISMATCH');
  });
});

describe('deck-time allocation (review finding 5)', () => {
  it('a loaded document with a 1e10 degC field is refused by the deck without sampling', () => {
    const fixture = withField(thermoFixture(), 1e10, 'degC');
    const started = Date.now();
    const cards = thermomechMaterialCards(deckContext(fixture), fixture.boxId);
    expect('code' in cards).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a field outside the model validity is refused before any table is built', () => {
    const fixture = withField(thermoFixture(), 5e4, 'K');
    const cards = thermomechMaterialCards(deckContext(fixture), fixture.boxId);
    expect(cards).toMatchObject({ code: 'TMC_PROPERTY_OUT_OF_RANGE' });
  });

  it('a valid but very wide range is tabulated with at most 1000 intervals', () => {
    const wide = {
      ...strainModel(1e-5),
      form: { kind: 'polynomial', variable: 'T', coefficients: [0, 1e-5, 1e-9], origin: 293.15 },
      validity: [{ variable: 'T', unit: 'K', data: [1, 1e6] }],
    };
    const fixture = withField(thermoFixture({ model: wide }), 1e5, 'K');
    const cards = thermomechMaterialCards(deckContext(fixture), fixture.boxId);
    if (!('text' in cards)) throw new Error(cards.message);
    const rows = cards.text.split('\n').filter((line) => /^[-0-9.e+]+, [-0-9.e+]+$/.test(line));
    expect(rows.length).toBeGreaterThan(900);
    expect(rows.length).toBeLessThanOrEqual(1001);
  });
});

describe('result and mesh limits (review finding 9)', () => {
  it('firstNonFinite locates NaN and Infinity cells in parsed result steps (review finding 8)', () => {
    const field = (values: number[]): { components: string[]; values: Record<string, number[]> } => ({
      components: ['D1'],
      values: { '7': values },
    });
    expect(firstNonFinite([{ step: 1, time: 0, fields: { DISP: field([1]) } }])).toBeNull();
    expect(firstNonFinite([{ step: 2, time: 1, fields: { DISP: field([1]), STRESS: field([Number.NaN]) } }])).toBe(
      'step 2 field STRESS node 7',
    );
    expect(firstNonFinite([{ step: 1, time: 0, fields: { DISP: field([Number.POSITIVE_INFINITY]) } }])).toBe('step 1 field DISP node 7');
    const source = readFileSync('tests/unit/cae/fixtures/static.frd', 'utf8');
    const at = source.indexOf(' -4  DISP');
    const resultLine = source.indexOf('\n -1', at) + 1;
    const blank = `${source.slice(0, resultLine + 13)}${' '.repeat(12)}${source.slice(resultLine + 25)}`;
    expect(firstNonFinite(parseFrd(source))).toBeNull();
    expect(firstNonFinite(parseFrd(blank))).toMatch(/^step 1 field DISP node /);
  });

  it('meshRequest refuses a mesh whose estimated element count exceeds the cap', () => {
    const { doc, analysisId } = modelWithAnalysis();
    expect('code' in meshRequest(doc, analysisId)).toBe(false);
    const fine = execute(doc, 'set_mesh_controls', { analysisId, globalSize: 0.01 });
    const refused = meshRequest(fine.document, analysisId);
    expect(refused).toMatchObject({ code: 'FEA_MESH_TOO_LARGE' });
    expect('message' in refused && refused.message).toMatch(/tetrahedra/);
  });
});
