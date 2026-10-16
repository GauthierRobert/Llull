import type { CommandResult } from '@core/commands/types';
import type { TemperatureFieldSource } from '@core/model/analysis';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { thermoFixture } from './fixtures';

const refusedWith = (result: ReturnType<typeof execute>, doc: unknown, code: string): void => {
  expectNoOp(result, doc);
  expect(result.rejected).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.summary).toContain(code);
};

describe('set_reference_temperature', () => {
  it('records the reference temperature with its unit', () => {
    const { doc, analysisId } = thermoFixture();
    const result = execute(doc, 'set_reference_temperature', { analysisId, value: 293.15, unit: 'K' });
    expect(result.affected).toEqual([analysisId]);
    expect(result.document.analysis?.cases[analysisId]?.thermomech?.referenceTemperature).toEqual({ value: 293.15, unit: 'K' });
    expect(result.document.analysis?.cases[analysisId]?.thermomech?.field).toEqual(doc.analysis?.cases[analysisId]?.thermomech?.field);
  });

  it('is pure', () => {
    const { doc, analysisId } = thermoFixture();
    expectPure(doc, () => execute(doc, 'set_reference_temperature', { analysisId, value: 25, unit: 'degC' }));
  });

  it('refuses an unknown analysis, a non thermo_static case and a non temperature unit', () => {
    const { doc, analysisId } = thermoFixture();
    refusedWith(execute(doc, 'set_reference_temperature', { analysisId: 'nope', value: 1, unit: 'K' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    const heat = execute(doc, 'create_analysis', { name: 'H', analysisType: 'heat_steady' });
    refusedWith(
      execute(heat.document, 'set_reference_temperature', { analysisId: heat.affected[0] ?? '', value: 1, unit: 'K' }),
      heat.document,
      'THM_CASE_TYPE',
    );
    refusedWith(execute(doc, 'set_reference_temperature', { analysisId, value: 5, unit: 'mm' }), doc, 'THM_UNITS_MISMATCH');
    refusedWith(execute(doc, 'set_reference_temperature', { analysisId, value: 5, unit: 'furlong' }), doc, 'THM_UNITS_MISMATCH');
  });
});

describe('set_temperature_field', () => {
  const field = (
    fixture: ReturnType<typeof thermoFixture>,
    source: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): CommandResult => execute(fixture.doc, 'set_temperature_field', { analysisId: fixture.analysisId, source, ...extra });

  it('records uniform, expression and table sources', () => {
    const fixture = thermoFixture({ field: null });
    const read = (r: ReturnType<typeof execute>): TemperatureFieldSource | undefined =>
      r.document.analysis?.cases[fixture.analysisId]?.thermomech?.field;
    expect(read(field(fixture, { kind: 'uniform', value: { value: 80, unit: 'degC' } }))).toEqual({
      kind: 'uniform',
      value: { value: 80, unit: 'degC' },
    });
    const expression = field(fixture, { kind: 'expression', expression: 'hypot(x, y) + z', coordinatesUnit: 'mm', temperatureUnit: 'K' });
    expect(expression.affected).toEqual([fixture.analysisId]);
    expect(read(expression)).toMatchObject({ kind: 'expression', expression: 'hypot(x, y) + z' });
    expect(read(field(fixture, { kind: 'table', csvSha256: 'ab', rows: 3, coordinatesUnit: 'mm', temperatureUnit: 'degC' }))).toMatchObject(
      { kind: 'table', rows: 3 },
    );
  });

  it('records a thermal_result source on a heat_* analysis with same_mesh mapping, and the cteBasis overrides', () => {
    const fixture = thermoFixture({ field: null });
    const heat = execute(fixture.doc, 'create_analysis', { name: 'H', analysisType: 'heat_transient' });
    const thermalId = heat.affected[0] ?? '';
    const result = execute(heat.document, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      source: { kind: 'thermal_result', analysisId: thermalId, time: 12.5 },
      cteBasis: { mat: { kind: 'secant', referenceTemperature: { value: 20, unit: 'degC' } }, other: { kind: 'instantaneous' } },
    });
    const setup = result.document.analysis?.cases[fixture.analysisId]?.thermomech;
    expect(setup?.field).toEqual({ kind: 'thermal_result', analysisId: thermalId, time: 12.5, mapping: 'same_mesh' });
    expect(Object.keys(setup?.cteBasis ?? {})).toEqual(['mat', 'other']);
    const later = execute(result.document, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      source: { kind: 'uniform', value: { value: 1, unit: 'K' } },
      cteBasis: { mat: { kind: 'instantaneous' } },
    });
    expect(later.document.analysis?.cases[fixture.analysisId]?.thermomech?.cteBasis).toEqual({
      mat: { kind: 'instantaneous' },
      other: { kind: 'instantaneous' },
    });
  });

  it('is pure', () => {
    const fixture = thermoFixture();
    expectPure(fixture.doc, () => field(fixture, { kind: 'uniform', value: { value: 80, unit: 'degC' } }));
  });

  it('refuses with stable codes: case, source, time, expression, units', () => {
    const fixture = thermoFixture();
    const { doc } = fixture;
    refusedWith(
      execute(doc, 'set_temperature_field', { analysisId: 'nope', source: { kind: 'uniform', value: { value: 1, unit: 'K' } } }),
      doc,
      'FEA_ANALYSIS_NOT_FOUND',
    );
    const staticCase = execute(doc, 'create_analysis', { name: 'S', analysisType: 'static' });
    refusedWith(
      execute(staticCase.document, 'set_temperature_field', {
        analysisId: staticCase.affected[0] ?? '',
        source: { kind: 'uniform', value: { value: 1, unit: 'K' } },
      }),
      staticCase.document,
      'THM_CASE_TYPE',
    );
    refusedWith(field(fixture, { kind: 'thermal_result', analysisId: 'missing', time: 'last' }), doc, 'TMC_FIELD_SOURCE_INVALID');
    refusedWith(
      field(fixture, { kind: 'thermal_result', analysisId: staticCase.affected[0] ?? '', time: 'last' }),
      staticCase.document === doc ? doc : doc,
      'TMC_FIELD_SOURCE_INVALID',
    );
    const heat = execute(doc, 'create_analysis', { name: 'H', analysisType: 'heat_steady' });
    refusedWith(
      execute(heat.document, 'set_temperature_field', {
        analysisId: fixture.analysisId,
        source: { kind: 'thermal_result', analysisId: heat.affected[0] ?? '', time: -1 },
      }),
      heat.document,
      'TMC_FIELD_SOURCE_INVALID',
    );
    refusedWith(
      field(fixture, { kind: 'expression', expression: '1 +', coordinatesUnit: 'mm', temperatureUnit: 'K' }),
      doc,
      'TMC_FIELD_INVALID',
    );
    refusedWith(
      field(fixture, { kind: 'expression', expression: 'w + x', coordinatesUnit: 'mm', temperatureUnit: 'K' }),
      doc,
      'TMC_FIELD_INVALID',
    );
    refusedWith(field(fixture, { kind: 'uniform', value: { value: 1, unit: 'mm' } }), doc, 'THM_UNITS_MISMATCH');
    refusedWith(
      field(fixture, { kind: 'table', csvSha256: 'ab', rows: 2, coordinatesUnit: 'parsec', temperatureUnit: 'K' }),
      doc,
      'TMC_FIELD_SOURCE_INVALID',
    );
    refusedWith(
      field(
        fixture,
        { kind: 'uniform', value: { value: 1, unit: 'K' } },
        { cteBasis: { mat: { kind: 'secant', referenceTemperature: { value: 1, unit: 'kg' } } } },
      ),
      doc,
      'THM_UNITS_MISMATCH',
    );
  });
});
