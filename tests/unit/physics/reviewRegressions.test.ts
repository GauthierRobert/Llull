/** Regression guards for the PHY-00 / PHY-01 review findings (each input once produced a wrong answer, a throw or a false check). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure, parseUnit } from '@lib/quantity';
import { withMaterial } from './propertyFixtures';

const source = { citation: 'regression fixture', locator: 'review' };
const base = withMaterial(createEmptyDocument(), 'm');

const model = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: 'x',
  property: 'k',
  unit: 'W/(m*K)',
  variables: [{ variable: 'T', unit: 'K' }],
  validity: [{ variable: 'T', unit: 'K', data: [100, 400] }],
  basis: 'company',
  source,
  ...extra,
});

const define = (doc: CadDocument, extra: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'define_property_model', { material: 'm', model: model(extra) });

describe('review regressions', () => {
  it('classifies equal differences (R = 1) as divergent, never extrapolating to infinity', () => {
    const data = execute(createEmptyDocument(), 'check_convergence', {
      quantity: 'q',
      unit: 'mm',
      samples: [
        { h: 1, value: 10 },
        { h: 2, value: 11 },
        { h: 4, value: 12 },
      ],
    }).data as Record<string, unknown>;
    expect(data['status']).toBe('divergent');
    expect(data).not.toHaveProperty('extrapolated');
  });

  it('refuses sampling across a gap of a nested table instead of throwing', () => {
    const doc = define(base, {
      form: {
        kind: 'piecewise',
        variable: 'T',
        segments: [
          {
            upTo: 200,
            form: {
              kind: 'table1d',
              variable: 'T',
              points: [
                [100, 1],
                [150, 2],
              ],
              interpolation: 'linear',
            },
          },
          { upTo: 400, form: { kind: 'constant', value: 3 } },
        ],
      },
    }).document;
    const result = execute(doc, 'sample_property', {
      material: 'm',
      property: 'k',
      variable: 'T',
      from: { value: 100, unit: 'K' },
      to: { value: 400, unit: 'K' },
      count: 2,
      integrate: true,
    });
    expect(result.error?.code).toBe('PROP_OUT_OF_RANGE');
    expect(result.summary).not.toMatch(/threw/);
    expect(
      define(base, {
        form: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [100, 1],
            [300, 2],
          ],
          interpolation: 'linear',
        },
      }).error?.code,
    ).toBe('PROP_RANGE_INVALID');
  });

  it('snaps an operating point that converts to a hair beyond the range bound', () => {
    const doc = define(base, {
      variables: [{ variable: 'T', unit: 'degC' }],
      validity: [{ variable: 'T', unit: 'degC', data: [-196, 26.85] }],
      form: {
        kind: 'table1d',
        variable: 'T',
        points: [
          [-196, 1],
          [26.85, 2],
        ],
        interpolation: 'linear',
      },
    }).document;
    const result = execute(doc, 'evaluate_property', { material: 'm', property: 'k', at: { T: { value: 300, unit: 'K' } } });
    expect(result.rejected).toBeUndefined();
    expect((result.data as { value: number }).value).toBeCloseTo(2, 12);
  });

  it('requires an absolute temperature unit for forms that read T absolutely', () => {
    const arrhenius = { kind: 'arrhenius', preFactor: 1, activationEnergyJPerMol: 1e5 };
    const result = define(base, {
      property: 'diffusionRate',
      unit: '1/s',
      variables: [{ variable: 'T', unit: 'degC' }],
      validity: [{ variable: 'T', unit: 'degC', data: [-100, 500] }],
      form: arrhenius,
    });
    expect(result.error?.code).toBe('MAT_UNIT_DIMENSION');
    const fit = execute(base, 'fit_property_model', {
      data: {
        variable: 'T',
        variableUnit: 'degC',
        valueUnit: '1/s',
        rows: [
          [100, 1],
          [200, 2],
          [300, 3],
        ],
      },
      form: 'arrhenius',
      property: 'diffusionRate',
      id: 'r',
    });
    expect(fit.error?.code).toBe('MAT_UNIT_DIMENSION');
  });

  it('fits data with a zero value and the fit is accepted unchanged', () => {
    const rows = [
      [293, 0],
      [400, 1.2e-3],
      [500, 2.4e-3],
      [600, 3.7e-3],
      [700, 5e-3],
    ];
    const fit = execute(base, 'fit_property_model', {
      data: { variable: 'T', variableUnit: 'K', valueUnit: '1', rows },
      form: 'polynomial',
      degree: 2,
      property: 'thermalStrain',
      id: 's',
    });
    const data = fit.data as { model: Record<string, unknown>; fit: { residual: { maxRel: number } } };
    expect(Number.isFinite(data.fit.residual.maxRel)).toBe(true);
    expect(execute(base, 'define_property_model', { material: 'm', model: data.model }).rejected).toBeUndefined();
    const logPolynomial = execute(base, 'fit_property_model', {
      data: { variable: 'T', variableUnit: 'K', valueUnit: '1', rows },
      form: 'polynomial',
      objective: 'log10',
      property: 'thermalStrain',
      id: 's',
    });
    expect(logPolynomial.error?.code).toBe('PROP_FIT_DATA_INVALID');
  });

  it('checks positivity in the range unit, not the variable unit', () => {
    const doc = execute(base, 'define_property_model', {
      material: 'm',
      model: model({
        property: 'cp',
        unit: 'J/(kg*K)',
        form: { kind: 'polynomial', variable: 'T', coefficients: [-100, 2] },
        validity: [{ variable: 'T', unit: 'degC', data: [0, 300] }],
      }),
    }).document;
    const items = (execute(doc, 'check_property_models', {}).data as { items: { code: string }[] }).items;
    expect(items.map((i) => i.code)).not.toContain('PROP_NONPOSITIVE_IN_RANGE');
  });

  it('keeps the ambiguity when several density models exist and none is preferred', () => {
    const density = (id: string): Record<string, unknown> =>
      model({ id, property: 'density', unit: 'kg/m^3', form: { kind: 'constant', value: 2700 }, variables: [], validity: [] });
    let doc = execute(base, 'define_property_model', { material: 'm', model: density('a') }).document;
    doc = execute(doc, 'define_property_model', { material: 'm', model: density('b') }).document;
    const result = execute(doc, 'evaluate_property', { material: 'm', property: 'density', at: {} });
    expect(result.error?.code).toBe('PROP_NO_MODEL_FOR_PROPERTY');
    expect((result.data as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('parses µ / μ prefixes and decimetres, and refuses non-positive scales', () => {
    const micro = convertValue(1, 'μm', 'mm');
    expect(isUnitFailure(micro) ? NaN : micro.value).toBeCloseTo(1e-3, 15);
    const dm = convertValue(1, 'dm', 'm');
    expect(isUnitFailure(dm) ? NaN : dm.value).toBeCloseTo(0.1, 15);
    expect(isUnitFailure(parseUnit('-2*K'))).toBe(true);
  });
});
