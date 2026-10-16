import type { CadDocument } from '@core/model/types';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { resolveTemperatureField } from '@cae/thermomech/field';
import { hashOf, portOf, thermoFixture, withThermalSource } from './fixtures';

const resolve = (
  fixture: ReturnType<typeof thermoFixture>,
  artifacts = null as ReturnType<typeof portOf> | null,
): ReturnType<typeof resolveTemperatureField> => resolveTemperatureField(fixture.doc, fixture.analysisId, fixture.mesh, artifacts);

describe('resolveTemperatureField', () => {
  it('resolves uniform and expression fields in the case scale', () => {
    const uniform = resolve(thermoFixture());
    expect(uniform).toMatchObject({ ok: true, values: [120, 120, 120, 120, 120], min: 120, max: 120 });
    const expression = resolve(
      thermoFixture({ field: { kind: 'expression', expression: 'x + y + z', coordinatesUnit: 'mm', temperatureUnit: 'degC' } }),
    );
    expect(expression).toMatchObject({ ok: true, values: [0, 10, 10, 10, 30], min: 0, max: 30 });
    const fahrenheit = resolve(
      thermoFixture({ field: { kind: 'expression', expression: '212', coordinatesUnit: 'mm', temperatureUnit: 'degF' } }),
    );
    expect(fahrenheit).toMatchObject({ ok: true });
    expect(fahrenheit.ok && fahrenheit.values[0]).toBeCloseTo(100, 9);
  });

  it('refuses a non-finite expression with the failing node count, and a case that is not thermo_static', () => {
    const bad = resolve(
      thermoFixture({ field: { kind: 'expression', expression: '1 / (x - 10)', coordinatesUnit: 'mm', temperatureUnit: 'K' } }),
    );
    expect(bad).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(!bad.ok && bad.message).toContain('2 of 5');
    const fixture = thermoFixture();
    const other = execute(fixture.doc, 'create_analysis', { name: 'S', analysisType: 'static' });
    expect(resolveTemperatureField(other.document, other.affected[0] ?? '', fixture.mesh, null)).toMatchObject({ code: 'THM_CASE_TYPE' });
    expect(resolveTemperatureField(fixture.doc, 'nope', fixture.mesh, null)).toMatchObject({ code: 'THM_CASE_TYPE' });
  });

  it('matches a table to mesh nodes within 1e-6 of the model size, in the declared units', () => {
    const base = thermoFixture();
    const rows = base.mesh.nodes.map(
      ([id, x, y, z]) => [x * 0.001 + 1e-9, y * 0.001, z * 0.001, 300 + id] as [number, number, number, number],
    );
    const artifact = { kind: 'fe_table', rows } as never;
    const hash = 'tablehash';
    const field = { kind: 'table', csvSha256: hash, rows: rows.length, coordinatesUnit: 'm', temperatureUnit: 'K' };
    const fixture = thermoFixture({ field });
    const port = { get: (key: string) => (key === hash ? artifact : null) };
    const ok = resolve(fixture, port);
    expect(ok.ok && ok.values.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([27.85, 28.85, 29.85, 30.85, 31.85]);
    const far = { kind: 'fe_table', rows: rows.map(([x, y, z, t]) => [x + 1e-3, y, z, t]) } as never;
    expect(resolve(fixture, { get: () => far })).toMatchObject({ ok: false, code: 'TMC_FIELD_TABLE_UNMATCHED' });
    expect(resolve(fixture, null)).toMatchObject({ ok: false, code: 'TMC_FIELD_SOURCE_INVALID' });
    expect(resolve(fixture, { get: () => ({ kind: 'fe_table', rows: rows.slice(1) }) as never })).toMatchObject({
      code: 'TMC_FIELD_SOURCE_INVALID',
    });
  });

  it('reads the NDTEMP of the thermal results on the same mesh at the last output time', () => {
    const source = withThermalSource(thermoFixture());
    const field = resolveTemperatureField(source.fixture.doc, source.fixture.analysisId, source.fixture.mesh, source.artifacts);
    expect(field).toMatchObject({ ok: true, values: [101, 102, 103, 104, 105], min: 101, max: 105 });
  });

  it('converts the thermal scale (K source into a degC case)', () => {
    const source = withThermalSource(thermoFixture(), { scale: 'K' });
    const field = resolveTemperatureField(source.fixture.doc, source.fixture.analysisId, source.fixture.mesh, source.artifacts);
    expect(field.ok && field.values[0]).toBeCloseTo(101 - 273.15, 9);
  });

  it('refuses a stale source, a mesh mismatch, an unsolved source and a missing artifact', () => {
    const source = withThermalSource(thermoFixture());
    const { doc, analysisId, mesh } = source.fixture;
    const stale = execute(doc, 'add_result_probe', {
      analysisId: source.thermalId,
      name: 'p',
      point: [1, 1, 1],
      quantity: 'temperature',
    }).document;
    expect(resolveTemperatureField(stale, analysisId, mesh, source.artifacts)).toMatchObject({ code: 'TMC_THERMAL_RESULT_STALE' });

    const other = withThermalSource(thermoFixture(), { meshHash: 'another-mesh' });
    expect(resolveTemperatureField(other.fixture.doc, other.fixture.analysisId, other.fixture.mesh, other.artifacts)).toMatchObject({
      code: 'TMC_MESH_MISMATCH',
    });
    expect(resolveTemperatureField(doc, analysisId, mesh, null)).toMatchObject({ code: 'FEA_RESULTS_MISSING' });
    expect(resolveTemperatureField(doc, analysisId, mesh, portOf({}))).toMatchObject({ code: 'FEA_RESULTS_MISSING' });

    const unsolvedDoc = execute(doc, 'create_analysis', { name: 'H2', analysisType: 'heat_steady' });
    const unsolved = execute(unsolvedDoc.document, 'set_temperature_field', {
      analysisId,
      source: { kind: 'thermal_result', analysisId: unsolvedDoc.affected[0] ?? '', time: 'last' },
    }).document;
    expect(resolveTemperatureField(unsolved, analysisId, mesh, source.artifacts)).toMatchObject({ code: 'FEA_RESULTS_MISSING' });
  });

  it('refuses an output time the results do not have and a results step without NDTEMP', () => {
    const source = withThermalSource(thermoFixture());
    const { doc, analysisId, mesh, boxId } = source.fixture;
    const atTime = (time: number | 'last'): CadDocument =>
      execute(doc, 'set_temperature_field', { analysisId, source: { kind: 'thermal_result', analysisId: source.thermalId, time } })
        .document;
    expect(resolveTemperatureField(atTime(5), analysisId, mesh, source.artifacts)).toMatchObject({ ok: true });
    expect(resolveTemperatureField(atTime(7), analysisId, mesh, source.artifacts)).toMatchObject({ code: 'TMC_FIELD_SOURCE_INVALID' });
    const noField = { ...source.results, steps: [{ step: 1, time: 5, fields: {} }] };
    const hash = hashOf(noField);
    const heat = doc.analysis?.cases[source.thermalId];
    const patched = {
      ...doc,
      analysis: {
        ...doc.analysis!,
        cases: { ...doc.analysis!.cases, [source.thermalId]: { ...heat!, results: { ...heat!.results!, resultsHash: hash } } },
      },
    };
    expect(boxId).toBeTruthy();
    expect(resolveTemperatureField(patched, analysisId, mesh, portOf({ [hash]: noField }))).toMatchObject({
      code: 'TMC_FIELD_SOURCE_INVALID',
    });
    const partial = { ...source.results, steps: [{ step: 1, time: 5, fields: { NDTEMP: { components: ['T'], values: { '1': [1] } } } }] };
    const partialHash = hashOf(partial);
    const patched2 = {
      ...patched,
      analysis: {
        ...patched.analysis,
        cases: {
          ...patched.analysis.cases,
          [source.thermalId]: { ...patched.analysis.cases[source.thermalId]!, results: { ...heat!.results!, resultsHash: partialHash } },
        },
      },
    };
    expect(resolveTemperatureField(patched2, analysisId, mesh, portOf({ [partialHash]: partial }))).toMatchObject({
      code: 'TMC_FIELD_INVALID',
    });
  });
});
