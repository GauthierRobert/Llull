/** compute_margins on thermo_static results: allowables are read at the solved temperature (conservative end of the region), never silently at the reference. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { hashOf, mustRun, portOf } from './deckFixtures';
import { marginBar, strengthModel } from './marginsFixtures';

interface Row {
  allowableMPa: number;
  allowableTemperatureK: number;
  allowableTemperatureRangeK: [number, number];
  allowableTemperatureBasis: string;
  allowable: { property: string };
  check: string;
}
interface Data {
  rows: Row[];
  warnings: string[];
}

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/marginsTemperature' };
const table = (property: string, points: [number, number][]): Record<string, unknown> => ({
  id: property.toLowerCase(),
  property,
  unit: 'MPa',
  variables: [{ variable: 'T', unit: 'K' }],
  validity: [{ variable: 'T', unit: 'K', data: [250, 500] }],
  form: { kind: 'table1d', variable: 'T', points, interpolation: 'linear' },
  basis: 'company',
  source: SOURCE,
});

/** thermo_static bar with strength models and a temperature field set BEFORE the results are recorded. */
function hotBar(
  models: Record<string, unknown>[],
  field: Record<string, unknown> | null,
): { doc: CadDocument; run: (p?: object) => ReturnType<typeof execute> } {
  const bar = marginBar({ analysisType: 'thermo_static', ftu: null, fty: null });
  let doc = bar.doc;
  for (const model of models) doc = mustRun(doc, 'define_property_model', { material: 'steel', model });
  if (field !== null) doc = mustRun(doc, 'set_temperature_field', { analysisId: bar.analysisId, source: field });
  const results = { ...bar.results, inputHash: analysisInputHash(doc, bar.analysisId, 'full') };
  const ctx = { ...bar.ctx, feaArtifacts: portOf(bar.mesh, results) };
  doc = execute(doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) }, ctx).document;
  doc = execute(
    doc,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(doc, bar.analysisId, bar.mesh, results, hashOf(results)) },
    ctx,
  ).document;
  return { doc, run: (params = {}) => execute(doc, 'compute_margins', { analysisId: bar.analysisId, ...params }, ctx) };
}

describe('compute_margins allowables at the solved temperature', () => {
  it('evaluates Fty(T) / Ftu(T) at the hottest node of the region and reports the temperature used per row', () => {
    const { run } = hotBar(
      [
        table('Ftu', [
          [250, 500],
          [500, 300],
        ]),
        table('Fty', [
          [250, 300],
          [500, 100],
        ]),
      ],
      { kind: 'expression', expression: '100 + 20 * x', coordinatesUnit: 'mm', temperatureUnit: 'degC' },
    );
    const result = run();
    expect(result.rejected).not.toBe(true);
    const data = result.data as Data;
    const fty = data.rows.find((row) => row.check === 'yield');
    const [low, high] = fty?.allowableTemperatureRangeK ?? [0, 0];
    expect(low).toBeCloseTo(373.15, 6);
    expect(high).toBeGreaterThan(low);
    expect(fty?.allowableTemperatureK).toBeCloseTo(high, 9);
    expect(fty?.allowableTemperatureBasis).toContain('solved temperature field');
    expect(fty?.allowableMPa).toBeCloseTo(300 - 0.8 * (high - 250), 6);
    expect(fty?.allowableMPa).toBeLessThan(300 - 0.8 * (293.15 - 250));
    expect(data.warnings.some((warning) => warning.includes('ALLOWABLE_ROOM_TEMPERATURE'))).toBe(false);
  });

  it('refuses a hot region outside the validity range of the strength model instead of using the reference value', () => {
    const { run } = hotBar([strengthModel('Ftu', 400), strengthModel('Fty', 250)], {
      kind: 'uniform',
      value: { value: 200, unit: 'degC' },
    });
    const result = run();
    expect(result.error?.code).toBe('FEA_MATERIAL_NO_ALLOWABLE');
    expect(result.summary).toContain('PROP_OUT_OF_RANGE');
  });

  it('warns that room-temperature (constant) allowables were used, with the temperature of the field', () => {
    const { run } = hotBar([strengthModel('Ftu', 400), strengthModel('Fty', 250)], {
      kind: 'uniform',
      value: { value: 100, unit: 'degC' },
    });
    const data = run().data as Data;
    const warning = data.warnings.find((entry) => entry.startsWith('FEA_ALLOWABLE_NOT_TEMPERATURE_DEPENDENT'));
    expect(warning).toContain('373.15 K');
    expect(data.rows[0]?.allowableTemperatureK).toBeCloseTo(373.15, 6);
  });

  it('falls back to the reference temperature with a warning when the case has no temperature field', () => {
    const { run } = hotBar(
      [
        table('Ftu', [
          [250, 500],
          [500, 300],
        ]),
      ],
      null,
    );
    const data = run({ allowable: 'ftu' }).data as Data;
    expect(data.rows[0]?.allowableTemperatureBasis).toContain('reference temperature');
    expect(data.rows[0]?.allowableTemperatureK).toBeCloseTo(293.15, 6);
    expect(data.warnings.some((entry) => entry.startsWith('FEA_ALLOWABLE_TEMPERATURE_UNKNOWN'))).toBe(true);
  });

  it('does not annotate temperature for an explicit allowable beyond a warning, and leaves static cases unchanged', () => {
    const { run } = hotBar([], { kind: 'uniform', value: { value: 100, unit: 'degC' } });
    const data = run({ allowable: { value: 300, unit: 'MPa' } }).data as Data;
    expect(data.rows[0]?.allowableMPa).toBe(300);
    expect(data.warnings.some((entry) => entry.startsWith('FEA_ALLOWABLE_NOT_TEMPERATURE_DEPENDENT'))).toBe(true);
    const staticBar = marginBar();
    const staticData = execute(staticBar.recorded, 'compute_margins', { analysisId: staticBar.analysisId }, staticBar.ctx).data as Data;
    expect(staticData.rows[0]).not.toHaveProperty('allowableTemperatureK');
    expect(staticData.warnings.some((entry) => entry.includes('ALLOWABLE'))).toBe(false);
  });

  it('is pure', () => {
    const { doc, run } = hotBar(
      [
        table('Ftu', [
          [250, 500],
          [500, 300],
        ]),
      ],
      { kind: 'uniform', value: { value: 100, unit: 'degC' } },
    );
    const before = JSON.stringify(doc);
    run({ allowable: 'ftu' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
