import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { checkThermomechItems } from '@cae/thermomech/check';
import { cteModel } from '../../physics/thermomech/thermomechFixtures';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import type { FeArtifactPort } from '@core/model/analysis';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary } from '@cae/results/summary';
import { withCase } from '@cae/shared/access';
import { hashOf, portOf, thermoFixture, withThermalSource, type Fixture } from './fixtures';

const withThermalLoad = (fixture: Fixture): Fixture => ({
  ...fixture,
  doc: execute(fixture.doc, 'add_fea_load', {
    analysisId: fixture.analysisId,
    name: 'g',
    kind: 'gravity',
    vector: [0, 0, -9810],
    loadCase: 'thermal',
    category: 'limit',
  }).document,
});

const codes = (fixture: Fixture, artifacts: FeArtifactPort | null = null): string[] =>
  checkThermomechItems(fixture.doc, fixture.analysisId, artifacts).map((item) => item.code);

describe('check_thermo_mechanical', () => {
  it('passes a complete set-up and reports the data contract', () => {
    const fixture = withThermalLoad(thermoFixture());
    const result = execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId });
    expect(result.rejected).toBeUndefined();
    expect(result.data).toMatchObject({ analysisId: fixture.analysisId, verdict: 'pass', items: [], reviewRequired: true });
    expect(result.summary).toContain('pass');
  });

  it('warns when the thermal load case carries no limit / ultimate category', () => {
    const fixture = thermoFixture();
    const result = execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId });
    expect(result.data).toMatchObject({ verdict: 'warn', reviewRequired: true });
    expect(codes(fixture)).toEqual(['TMC_THERMAL_CATEGORY_UNSET']);
  });

  it('is pure and read-only', () => {
    const fixture = thermoFixture();
    expectPure(fixture.doc, () => execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId }));
    const result = execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId });
    expect(result.document).toBe(fixture.doc);
    expect(result.affected).toEqual([]);
  });

  it('reports a missing field, an unparsable expression and CTE problems', () => {
    expect(codes(withThermalLoad(thermoFixture({ field: null })))).toEqual(['TMC_FIELD_SOURCE_INVALID']);
    const bad = thermoFixture({ field: { kind: 'uniform', value: { value: 1, unit: 'K' } } });
    const broken = {
      ...bad.doc,
      analysis: {
        ...bad.doc.analysis!,
        cases: {
          ...bad.doc.analysis!.cases,
          [bad.analysisId]: {
            ...bad.doc.analysis!.cases[bad.analysisId]!,
            thermomech: {
              ...bad.doc.analysis!.cases[bad.analysisId]!.thermomech!,
              field: { kind: 'expression' as const, expression: 'q * x', coordinatesUnit: 'mm' as const, temperatureUnit: 'K' as const },
            },
          },
        },
      },
    };
    expect(checkThermomechItems(broken, bad.analysisId).map((i) => i.code)).toContain('TMC_FIELD_INVALID');
    expect(codes(withThermalLoad(thermoFixture({ model: null })))).toEqual(['TMC_MATERIAL_NO_CTE']);
    const unstated = thermoFixture({
      model: { ...cteModel({ kind: 'constant', value: 1e-5 }), variables: [{ variable: 'T', unit: 'K' }] },
    });
    expect(codes(withThermalLoad(unstated))).toEqual(['TMC_CTE_BASIS_UNKNOWN']);
  });

  it('flags unverified CTE (TMC_MATERIAL_UNVERIFIED warning) and a reference outside the model validity', () => {
    const typical = withThermalLoad(
      thermoFixture({
        model: {
          id: 'strain',
          property: 'thermalStrain',
          unit: '1',
          basis: 'typical',
          form: { kind: 'polynomial', variable: 'T', coefficients: [0, 1e-5], origin: 293.15 },
          variables: [{ variable: 'T', unit: 'K' }],
        },
      }),
    );
    const items = checkThermomechItems(typical.doc, typical.analysisId);
    expect(items.map((i) => [i.code, i.severity])).toEqual([['TMC_MATERIAL_UNVERIFIED', 'warning']]);
    expect(items[0]?.remediation).toBeTruthy();
    const cold = execute(typical.doc, 'set_reference_temperature', { analysisId: typical.analysisId, value: 0, unit: 'K' });
    expect(codes({ ...typical, doc: cold.document })).toContain('TMC_PROPERTY_OUT_OF_RANGE');
  });

  it('reports the thermal source states: stale, other mesh, unsolved, unknown output time', () => {
    const source = withThermalSource(withThermalLoad(thermoFixture()));
    expect(codes(source.fixture, source.artifacts)).toEqual([]);
    const stale = execute(source.fixture.doc, 'add_result_probe', {
      analysisId: source.thermalId,
      name: 'p',
      point: [1, 1, 1],
      quantity: 'temperature',
    });
    expect(codes({ ...source.fixture, doc: stale.document })).toEqual(['TMC_THERMAL_RESULT_STALE']);
    expect(codes({ ...source.fixture, doc: stale.document }, source.artifacts)).toEqual(['TMC_THERMAL_RESULT_STALE']);
    const wrongTime = execute(source.fixture.doc, 'set_temperature_field', {
      analysisId: source.fixture.analysisId,
      source: { kind: 'thermal_result', analysisId: source.thermalId, time: 99 },
    });
    expect(codes({ ...source.fixture, doc: wrongTime.document }, source.artifacts)).toEqual(['TMC_FIELD_SOURCE_INVALID']);
    const heat = execute(source.fixture.doc, 'create_analysis', { name: 'H2', analysisType: 'heat_steady' });
    const unsolved = execute(heat.document, 'set_temperature_field', {
      analysisId: source.fixture.analysisId,
      source: { kind: 'thermal_result', analysisId: heat.affected[0] ?? '', time: 'last' },
    });
    expect(codes({ ...source.fixture, doc: unsolved.document }, source.artifacts)).toEqual(['FEA_RESULTS_MISSING']);
    // a thermal case solved on another discretisation than the thermo-mechanical case's recorded mesh
    const base = withThermalLoad(thermoFixture());
    const moved = { ...base.mesh, nodes: base.mesh.nodes.map((node) => (node[0] === 5 ? ([5, 11, 10, 10] as const) : node)) };
    const other = withThermalSource(base, { mesh: moved });
    const own = { ...base.mesh, inputHash: analysisInputHash(other.fixture.doc, base.analysisId, 'mesh') };
    const ownCase = other.fixture.doc.analysis!.cases[base.analysisId]!;
    const mismatched = withCase(other.fixture.doc, { ...ownCase, meshSummary: meshSummary(own, hashOf(own)) });
    const store = portOf({ [hashOf(own)]: own, [other.resultsHash]: other.results, [hashOf(other.thermalMesh)]: other.thermalMesh });
    expect(checkThermomechItems(mismatched, base.analysisId, store).map((i) => i.code)).toContain('TMC_MESH_MISMATCH');
    // only node / face sets and targets differ: one discretisation
    const sibling = { ...base.mesh, nodeSets: { B_1: [1] } };
    const same = withThermalSource(base, { mesh: sibling });
    const sameOwn = { ...base.mesh, inputHash: analysisInputHash(same.fixture.doc, base.analysisId, 'mesh') };
    const sameDoc = withCase(same.fixture.doc, {
      ...same.fixture.doc.analysis!.cases[base.analysisId]!,
      meshSummary: meshSummary(sameOwn, hashOf(sameOwn)),
    });
    const sameStore = portOf({
      [hashOf(sameOwn)]: sameOwn,
      [same.resultsHash]: same.results,
      [hashOf(same.thermalMesh)]: same.thermalMesh,
    });
    expect(checkThermomechItems(sameDoc, base.analysisId, sameStore).map((i) => i.code)).not.toContain('TMC_MESH_MISMATCH');
    // no artifact store: the thermal source cannot be verified, so it is not used
    expect(checkThermomechItems(source.fixture.doc, source.fixture.analysisId).map((i) => i.code)).toEqual(['FEA_RESULTS_MISSING']);
  });

  it('refuses unknown and non thermo_static analyses', () => {
    const fixture = thermoFixture();
    const unknown = execute(fixture.doc, 'check_thermo_mechanical', { analysisId: 'nope' });
    expectNoOp(unknown, fixture.doc);
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const heat = execute(fixture.doc, 'create_analysis', { name: 'H', analysisType: 'heat_steady' });
    const wrong = execute(heat.document, 'check_thermo_mechanical', { analysisId: heat.affected[0] ?? '' });
    expect(wrong.error?.code).toBe('THM_CASE_TYPE');
    expect(checkThermomechItems(fixture.doc, 'nope').map((i) => i.code)).toEqual(['FEA_ANALYSIS_NOT_FOUND']);
    expect(checkThermomechItems(heat.document, heat.affected[0] ?? '').map((i) => i.code)).toEqual(['THM_CASE_TYPE']);
  });

  it('an error item makes the verdict fail', () => {
    const fixture = withThermalLoad(thermoFixture({ model: null }));
    const result = execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId });
    expect(result.data).toMatchObject({ verdict: 'fail' });
  });
});
