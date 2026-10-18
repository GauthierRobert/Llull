import { describe, expect, it } from 'vitest';
import { mechanicalMaterialLines } from '@cae/decks/mechanical';
import { elasticTable } from '@cae/decks/elastic';
import { checkThermomechItems } from '@cae/thermomech/check';
import type { Material } from '@core/model/types';
import { withModel } from '../../physics/thermomech/thermomechFixtures';
import { deckContext, thermoFixture, type Fixture } from './fixtures';

const lines = (fixture: Fixture): string[] => {
  const sections = mechanicalMaterialLines(deckContext(fixture), fixture.boxId);
  if (!('text' in sections)) throw new Error(JSON.stringify(sections));
  return sections.text.split('\n').filter((line) => line !== '');
};

const eModel = (points: number[][], validity: number[] = [200, 500]): Record<string, unknown> => ({
  id: 'E.tab',
  property: 'E',
  unit: 'MPa',
  form: { kind: 'table1d', variable: 'T', points, interpolation: 'linear' },
  validity: [{ variable: 'T', unit: 'K', data: validity }],
  basis: 'company',
});
const nuModel = (value: number): Record<string, unknown> => ({
  id: 'nu.const',
  property: 'nu',
  unit: '1',
  form: { kind: 'polynomial', variable: 'T', coefficients: [value] },
  validity: [{ variable: 'T', unit: 'K', data: [200, 800] }],
  basis: 'company',
});

function withElastic(fixture: Fixture, e: Record<string, unknown>): Fixture {
  return { ...fixture, doc: withModel(withModel(fixture.doc, 'mat', e), 'mat', nuModel(0.3)) };
}

describe('thermo_static *ELASTIC follows E(T)', () => {
  it('writes E, nu, T rows (case scale) over the field range for an E(T) table; E at 400 degC is the interpolated value', () => {
    const base = thermoFixture({ field: { kind: 'uniform', value: { value: 400, unit: 'degC' } } });
    const fixture = withElastic(
      base,
      eModel(
        [
          [200, 205000],
          [293.15, 200000],
          [573.15, 185000],
          [773.15, 170000],
        ],
        [200, 773.15],
      ),
    );
    const written = lines(fixture);
    const start = written.indexOf('*ELASTIC');
    const rows = written.slice(start + 1, written.indexOf('*DENSITY')).map((line) => line.split(', ').map(Number));
    expect(rows[0]).toEqual([200000, 0.3, 20]);
    const at400 = rows.find((row) => row[2] === 400);
    expect(at400?.[0]).toBeCloseTo(177500, 3);
    expect(rows.every((row) => row.length === 3)).toBe(true);
    expect(written.join('\n')).toContain('E, nu tabulated against temperature (degC)');
  });

  it('keeps one constant row when E and nu do not depend on temperature', () => {
    const fixture = withElastic(
      thermoFixture(),
      eModel([
        [200, 70000],
        [500, 70000],
      ]),
    );
    const written = lines(fixture);
    expect(written.slice(written.indexOf('*ELASTIC'), written.indexOf('*DENSITY'))).toEqual(['*ELASTIC', '70000, 0.3']);
  });

  it('refuses a field that leaves the validity range of E(T)', () => {
    const fixture = withElastic(
      thermoFixture({ field: { kind: 'uniform', value: { value: 400, unit: 'degC' } } }),
      eModel(
        [
          [250, 200000],
          [500, 190000],
        ],
        [250, 500],
      ),
    );
    const sections = mechanicalMaterialLines(deckContext(fixture), fixture.boxId);
    expect(sections).toHaveProperty('code');
  });

  it('elasticTable samples every 10 K between the ends, extended to the reference', () => {
    const base = withElastic(
      thermoFixture(),
      eModel([
        [200, 100000],
        [500, 90000],
      ]),
    );
    const material = base.doc.materials['mat'] as Material;
    const table = elasticTable(material, 'mat', 293.15, 300, 330);
    expect('rows' in table && table.rows.length).toBe(5);
  });
});

describe('check_thermo_mechanical TMC_ELASTIC_NOT_TEMPERATURE_DEPENDENT', () => {
  const codes = (fixture: Fixture): string[] => checkThermomechItems(fixture.doc, fixture.analysisId).map((entry) => entry.code);

  it('warns when E is constant and the field spans more than 50 K', () => {
    const fixture = withElastic(
      thermoFixture({ field: { kind: 'uniform', value: { value: 120, unit: 'degC' } } }),
      eModel([
        [200, 70000],
        [500, 70000],
      ]),
    );
    const item = checkThermomechItems(fixture.doc, fixture.analysisId).find(
      (entry) => entry.code === 'TMC_ELASTIC_NOT_TEMPERATURE_DEPENDENT',
    );
    expect(item?.severity).toBe('warning');
    expect(item?.message).toContain('100 K');
  });

  it('does not warn for a small span or a temperature-dependent E', () => {
    const small = withElastic(
      thermoFixture({ field: { kind: 'uniform', value: { value: 40, unit: 'degC' } } }),
      eModel([
        [200, 70000],
        [500, 70000],
      ]),
    );
    expect(codes(small)).not.toContain('TMC_ELASTIC_NOT_TEMPERATURE_DEPENDENT');
    const dependent = withElastic(
      thermoFixture(),
      eModel([
        [200, 100000],
        [500, 80000],
      ]),
    );
    expect(codes(dependent)).not.toContain('TMC_ELASTIC_NOT_TEMPERATURE_DEPENDENT');
  });
});
