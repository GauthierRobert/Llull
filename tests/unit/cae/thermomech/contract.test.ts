/** Agent-first contract cases of the PHY-04 pack (VC-TMC-50, 60, 61, 63) judged against expected_results.json. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectCase, packCase } from '../../physics/benchmarkCases';
import { G6, H7, PACK, SPEC_20C, cteModel, strainModel, withModel } from '../../physics/thermomech/thermomechFixtures';
import { checkThermomechItems } from '@cae/thermomech/check';
import { resolveTemperatureField } from '@cae/thermomech/field';
import { thermoFixture, withThermalSource } from './fixtures';

describe('PHY-04 agent-first contract (VC-TMC)', () => {
  it('VC-TMC-60: no silent reference temperature, no silent spec temperature', () => {
    const doc = createEmptyDocument();
    const missingReference = execute(doc, 'create_analysis', { name: 'T', analysisType: 'thermo_static' });
    const fit = execute(doc, 'fit_at_temperature', { hole: H7, shaft: G6, temperatures: [SPEC_20C] });
    expectCase(PACK, 'VC-TMC-60', {
      'thermo_static without referenceTemperature': missingReference.error?.code ?? null,
      'fit_at_temperature without specTemperature': fit.error?.code ?? null,
    });
  });

  it('VC-TMC-61: the seven wrong set-ups return their stable codes', () => {
    const base = thermoFixture();
    const source = withThermalSource(base);
    const stale = execute(source.fixture.doc, 'add_result_probe', {
      analysisId: source.thermalId,
      name: 'p',
      point: [1, 1, 1],
      quantity: 'temperature',
    }).document;
    const otherBase = thermoFixture();
    const moved = { ...otherBase.mesh, nodes: otherBase.mesh.nodes.map((node) => (node[0] === 5 ? ([5, 11, 10, 10] as const) : node)) };
    const mismatch = withThermalSource(otherBase, { mesh: moved });
    const noCte = thermoFixture({ model: null });
    const unstated = thermoFixture({
      model: { ...cteModel({ kind: 'constant', value: 1e-5 }), variables: [{ variable: 'T', unit: 'K' }] },
    });
    const fitNoLimits = execute(createEmptyDocument(), 'fit_at_temperature', { specTemperature: SPEC_20C, temperatures: [SPEC_20C] });
    const materials = withModel(withModel(createEmptyDocument(), 'al', strainModel(2.3e-5)), 'steel', strainModel(1.2e-5));
    const outside = execute(materials, 'fit_at_temperature', {
      hole: H7,
      shaft: G6,
      holeMaterial: 'al',
      shaftMaterial: 'steel',
      specTemperature: SPEC_20C,
      temperatures: [{ value: 500, unit: 'degC' }],
    });
    const gate = execute(
      base.doc,
      'dispose_fit_result',
      { rowKey: 'r', decision: 'accepted', justification: 'j', inputsHash: 'h', signature: 's' },
      defaultContext(),
    );
    const first = (fixture: typeof base, doc = fixture.doc): string =>
      checkThermomechItems(doc, fixture.analysisId).find((item) => item.severity === 'error')?.code ?? 'none';
    const thermalPort = source.artifacts;
    expectCase(PACK, 'VC-TMC-61', [
      {
        setup: 'thermo_static referencing a stale heat_steady result',
        code: (resolveTemperatureField(stale, source.fixture.analysisId, source.fixture.mesh, thermalPort) as { code: string }).code,
      },
      {
        setup: 'thermo_static referencing a result whose mesh differs and no mapping allowed',
        code: (
          resolveTemperatureField(mismatch.fixture.doc, mismatch.fixture.analysisId, mismatch.fixture.mesh, mismatch.artifacts) as {
            code: string;
          }
        ).code,
      },
      { setup: 'part material has no cte', code: first(noCte) },
      { setup: 'cte table given as instantaneous but no reference temperature', code: first(unstated) },
      { setup: 'fit_at_temperature on a size dimension without limits', code: fitNoLimits.error?.code ?? 'none' },
      { setup: 'fit_at_temperature temperature outside the cte table range', code: outside.error?.code ?? 'none' },
      { setup: 'agent calls dispose_fit_result', code: gate.error?.code ?? 'none' },
    ]);
  });

  it('VC-TMC-63: an agent cannot disposition a fit, document unchanged', () => {
    const { doc } = thermoFixture();
    const result = execute(doc, 'dispose_fit_result', {
      rowKey: 'r',
      decision: 'accepted',
      justification: 'j',
      inputsHash: 'h',
      signature: 's',
    });
    expectCase(PACK, 'VC-TMC-63', {
      'dispose_fit_result(agent).code': result.error?.code ?? null,
      documentHashUnchanged: result.document === doc,
    });
  });

  it('VC-TMC-50 (check side): editing the thermal case makes check_thermo_mechanical report TMC_THERMAL_RESULT_STALE', () => {
    // all three keys together (fea_report state, compute_margins code, check items) are judged in margins.test.ts
    const source = withThermalSource(thermoFixture());
    const edited = execute(source.fixture.doc, 'add_result_probe', {
      analysisId: source.thermalId,
      name: 'p',
      point: [1, 1, 1],
      quantity: 'temperature',
    }).document;
    const items = checkThermomechItems(edited, source.fixture.analysisId).filter((item) => item.severity === 'error');
    expect(items.map((item) => item.code)).toEqual(['TMC_THERMAL_RESULT_STALE']);
    expect(packCase(PACK, 'VC-TMC-50').expected).toMatchObject({ 'check_thermo_mechanical(ms).items': ['TMC_THERMAL_RESULT_STALE'] });
  });
});
