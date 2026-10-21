/** PHY-01: forms, ranges, units, bands and derived CTE through evaluate_property, against docs/physics/01-property-models/validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { evaluateForm } from '@core/model/propertyForms';
import { expectCase, packCases } from './benchmarkCases';
import { PACK, nistDocument, withMaterial } from './propertyFixtures';

const doc = nistDocument();

type Evaluation = {
  value: number;
  unit: string;
  rangeStatus: string;
  unverified: boolean;
  unverifiedReasons: string[];
  band?: { low: number; high: number; kind: string };
  warnings: { code: string }[];
  defaults: { name: string }[];
  derivative?: { value: number; unit: string };
};

const evaluate = (
  document: CadDocument,
  params: Record<string, unknown>,
): { result: CommandResult; data: Evaluation & { code?: string } } => {
  const result = execute(document, 'evaluate_property', params);
  return { result, data: result.data as Evaluation & { code?: string } };
};

const at = (value: number, unit = 'K'): { T: { value: number; unit: string } } => ({ T: { value, unit } });

const define = (document: CadDocument, material: string, model: Record<string, unknown>): CadDocument => {
  const result = execute(document, 'define_property_model', { material, model });
  expect(result.rejected, result.summary).toBeUndefined();
  return result.document;
};

const source = { citation: 'synthetic fixture (validation pack)', locator: 'generate_prop_reference.py' };

describe('NIST cryogenic fits (VC-PROP-01…07)', () => {
  const pointCases = [...packCases(PACK).keys()].filter((id) => /^VC-PROP-0[1-79]\/[^/]+\/T=[\d.]+K$/.test(id));

  it('evaluates every fit at every reference temperature', () => {
    expect(pointCases.length).toBeGreaterThan(40);
    for (const caseId of pointCases) {
      const [, fitId = '', temperature = ''] = /^VC-PROP-0\d\/([^/]+)\/T=([\d.]+)K$/.exec(caseId) ?? [];
      const [material = '', ...rest] = fitId.split('.');
      const property = rest[0] ?? '';
      const condition = rest[1]?.startsWith('rrr') === true ? { rrr: Number(rest[1].slice(3)) } : undefined;
      const outputUnit = property === 'thermalStrain' ? '1' : undefined;
      const { result, data } = evaluate(doc, {
        material,
        property,
        at: at(Number(temperature)),
        ...(condition !== undefined ? { condition } : {}),
        ...(outputUnit !== undefined ? { outputUnit } : {}),
      });
      expect(result.rejected, `${caseId}: ${result.summary}`).toBeUndefined();
      expectCase(PACK, caseId, data.value, data.unit);
    }
  });

  it('derives the instantaneous CTE s′/(1 + s) from thermal strain', () => {
    const { data, result } = evaluate(doc, { material: 'aa6061_t6', property: 'cte', at: at(77) });
    expect(result.summary).toContain('cte');
    expect(data.unit).toBe('1/K');
    expectCase(PACK, 'VC-PROP-07/aa6061_t6.cte/T=77K', data.value, data.unit);
    expectCase(PACK, 'VC-PROP-07/aa6061_t6.cte/T=200K', evaluate(doc, { material: 'aa6061_t6', property: 'cte', at: at(200) }).data.value);
    expectCase(PACK, 'VC-PROP-07/aa6061_t6.cte/T=293K', evaluate(doc, { material: 'aa6061_t6', property: 'cte', at: at(293) }).data.value);
    const strain = evaluate(doc, { material: 'aa6061_t6', property: 'thermalStrain', at: at(293), derivative: 'T', outputUnit: '1' }).data;
    expect(strain.derivative?.value).toBeCloseTo(2.264e-5, 7);
  });
});

describe('range guard (VC-PROP-08, 18)', () => {
  it('refuses outside the equation range and warns between data and equation range', () => {
    for (const caseId of [...packCases(PACK).keys()].filter((id) => id.startsWith('VC-PROP-08/'))) {
      const [, fitId = '', temperature = ''] = /^VC-PROP-08\/([^/]+)\/T=([\d.]+)K$/.exec(caseId) ?? [];
      const [material = '', property = ''] = fitId.split('.');
      const { result, data } = evaluate(doc, { material, property, at: at(Number(temperature)) });
      const status = result.rejected === true ? (result.error?.code ?? '') : data.rangeStatus;
      expectCase(PACK, caseId, status);
      if (status === 'in_equation_range_only') {
        expect(data.value).toBeCloseTo(Number(packCases(PACK).get(caseId)?.['valueIfWarned']), 9);
        expect(data.unverifiedReasons).toContain('outside data range');
        expect(data.warnings[0]?.code).toBe('PROP_OUTSIDE_DATA_RANGE');
      } else if (result.rejected === true) {
        expect(result.document).toBe(doc);
        expect(result.error?.remediation).toMatch(/never extrapolates/);
      }
    }
    const typical = evaluate(doc, { material: 'aa6061_t6', property: 'k', at: at(77) }).data;
    expectCase(PACK, 'VC-PROP-18/unverified', typical.unverified && typical.unverifiedReasons.join() === 'basis typical');
    const outside = evaluate(doc, { material: 'ti6al4v', property: 'k', at: at(21) }).data;
    expectCase(
      PACK,
      'VC-PROP-18/outsideDataRange',
      outside.rangeStatus === 'in_equation_range_only' && outside.unverified && outside.warnings[0]?.code === 'PROP_OUTSIDE_DATA_RANGE',
    );
  });
});

describe('units and bands (VC-PROP-15, 16)', () => {
  it('converts the operating point and the answer', () => {
    expectCase(
      PACK,
      'VC-PROP-16/aa6061_t6.k/T=-196degC',
      evaluate(doc, { material: 'aa6061_t6', property: 'k', at: at(-196, 'degC') }).data.value,
    );
    expectCase(
      PACK,
      'VC-PROP-16/aa6061_t6.k/T=-320degF',
      evaluate(doc, { material: 'aa6061_t6', property: 'k', at: at(-320, 'degF') }).data.value,
    );
    const perMm = evaluate(doc, { material: 'aa6061_t6', property: 'k', at: at(77), outputUnit: 'W/(mm*K)', derivative: 'T' }).data;
    expectCase(PACK, 'VC-PROP-16/aa6061_t6.k/T=77K/in_W_per_mm_K', perMm.value, perMm.unit);
    expect(perMm.derivative?.unit).toBe('(W/(mm*K))/(K)');
  });

  it('returns the fit-error band with its kind', () => {
    const { data } = evaluate(doc, { material: 'aa6061_t6', property: 'k', at: at(77), band: true });
    expect(data.band?.kind).toBe('fitErrorVsData');
    expectCase(PACK, 'VC-PROP-15/aa6061_t6.k/band@77K', [data.band?.low ?? 0, data.band?.high ?? 0]);
  });
});

describe('synthetic forms (VC-PROP-10…12, 17)', () => {
  it('evaluates arrhenius, tables, table2d and rate factors', () => {
    let d = withMaterial(createEmptyDocument(), 'syn');
    d = define(d, 'syn', {
      id: 'rate',
      property: 'diffusionRate',
      unit: '1/s',
      variables: [{ variable: 'T', unit: 'K' }],
      form: { kind: 'arrhenius', preFactor: 1e-3, activationEnergyJPerMol: 150e3 },
      validity: [{ variable: 'T', unit: 'K', data: [500, 1000] }],
      basis: 'unspecified',
      source,
    });
    for (const t of [600, 800, 1000])
      expectCase(PACK, `VC-PROP-10/arrhenius/T=${t}K`, evaluate(d, { material: 'syn', property: 'diffusionRate', at: at(t) }).data.value);
    for (const mode of ['linear', 'loglog', 'loglinear', 'step']) {
      d = define(d, 'syn', {
        id: `k.${mode}`,
        property: 'k',
        unit: 'W/(m*K)',
        variables: [{ variable: 'T', unit: 'K' }],
        form: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [100, 10],
            [200, 40],
            [400, 160],
          ],
          interpolation: mode,
        },
        validity: [{ variable: 'T', unit: 'K', data: [100, 400] }],
        basis: 'company',
        source,
      });
      expectCase(
        PACK,
        `VC-PROP-11/table1d/${mode}/T=300K`,
        evaluate(d, { material: 'syn', property: 'k', modelId: `k.${mode}`, at: at(300) }).data.value,
      );
    }
    const stepDerivative = execute(d, 'evaluate_property', {
      material: 'syn',
      property: 'k',
      modelId: 'k.step',
      at: at(300),
      derivative: 'T',
    });
    expect(stepDerivative.error?.code).toBe('PROP_DERIVATIVE_UNAVAILABLE');
    d = define(d, 'syn', {
      id: 'fty',
      property: 'Fty',
      unit: 'MPa',
      variables: [
        { variable: 'T', unit: 'K' },
        { variable: 'strainRate', unit: '1/s' },
      ],
      form: {
        kind: 'table2d',
        x: { variable: 'T', unit: 'K' },
        y: { variable: 'strainRate', unit: '1/s', axis: 'log10' },
        xs: [293, 473],
        ys: [1e-3, 1e3],
        values: [
          [300, 360],
          [250, 320],
        ],
        interpolation: 'bilinear',
      },
      validity: [
        { variable: 'T', unit: 'K', data: [293, 473] },
        { variable: 'strainRate', unit: '1/s', data: [1e-3, 1e3] },
      ],
      basis: 'company',
      source,
    });
    const fty = evaluate(d, {
      material: 'syn',
      property: 'Fty',
      at: { T: { value: 383, unit: 'K' }, strainRate: { value: 1, unit: '1/s' } },
    }).data;
    expectCase(PACK, 'VC-PROP-12/table2d/T=383K,rate=1/s', fty.value);
    expect(fty.unverified).toBe(false);
    for (const [id, form, caseId] of [
      ['jc', { kind: 'rateFactor', law: 'johnsonCook', C: 0.014, referenceRate: 1 }, 'VC-PROP-12/rateFactor/johnsonCook'],
      ['cs', { kind: 'rateFactor', law: 'cowperSymonds', D: 40.4, q: 5 }, 'VC-PROP-12/rateFactor/cowperSymonds'],
    ] as const) {
      d = define(d, 'syn', {
        id,
        property: 'rateFactor',
        unit: '1',
        variables: [{ variable: 'strainRate', unit: '1/s' }],
        form,
        validity: [{ variable: 'strainRate', unit: '1/s', data: [1e-4, 1e4] }],
        basis: 'company',
        source,
      });
      expectCase(
        PACK,
        caseId,
        evaluate(d, { material: 'syn', property: 'rateFactor', modelId: id, at: { strainRate: { value: 1000, unit: '1/s' } } }).data.value,
      );
    }
    const clamped = evaluate(d, {
      material: 'syn',
      property: 'rateFactor',
      modelId: 'jc',
      at: { strainRate: { value: 0.01, unit: '1/s' } },
    }).data;
    expect(clamped.value).toBe(1);
    expect(clamped.defaults.map((x) => x.name)).toEqual(['johnsonCookBelowReferenceRate']);
  });

  it('evaluates an 08-style percent-of-room-temperature table as ratioOf (VC-PROP-17)', () => {
    let d = withMaterial(createEmptyDocument(), 'al');
    d = define(d, 'al', {
      id: 'ftu.rt',
      property: 'Ftu',
      unit: 'ksi',
      variables: [],
      form: { kind: 'constant', value: 60 },
      validity: [],
      basis: 'A',
      source,
    });
    d = define(d, 'al', {
      id: 'ftu.T',
      property: 'Ftu',
      unit: 'ksi',
      variables: [{ variable: 'T', unit: 'degF' }],
      form: {
        kind: 'ratioOf',
        baseModelId: 'ftu.rt',
        ratio: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [70, 1],
            [300, 0.8],
            [500, 0.5],
          ],
          interpolation: 'linear',
        },
      },
      validity: [{ variable: 'T', unit: 'degF', data: [70, 500] }],
      basis: 'A',
      source,
      preferred: true,
    });
    const { data } = evaluate(d, { material: 'al', property: 'Ftu', at: at(400, 'degF'), derivative: 'T' });
    expectCase(PACK, 'VC-PROP-17/legacy08PercentOfRT/T=400degF', data.value, data.unit);
    expect(data.derivative?.value).toBeCloseTo((60 * -0.3) / 200, 12);
    expect(execute(d, 'delete_property_model', { material: 'al', modelId: 'ftu.rt' }).error?.code).toBe('PROP_MODEL_IN_USE');
  });

  it('evaluates powerLaw, product and polynomial origin with derivatives', () => {
    const power = evaluateForm({ kind: 'powerLaw', variable: 'T', coefficient: 2, exponent: 3, reference: 10 }, { T: 20 }, 'T');
    expect(power).toEqual({ value: 16, derivative: (3 * 16) / 20 });
    const product = evaluateForm(
      {
        kind: 'product',
        factors: [
          { kind: 'polynomial', variable: 'T', coefficients: [0, 1], origin: 1 },
          { kind: 'constant', value: 3 },
        ],
      },
      { T: 5 },
      'T',
    );
    expect(product).toEqual({ value: 12, derivative: 3 });
    expect(evaluateForm({ kind: 'polynomial', variable: 'T', coefficients: [1] }, {})).toMatchObject({ code: 'PROP_VARIABLE_MISSING' });
    expect(evaluateForm({ kind: 'ratioOf', baseModelId: 'x', ratio: { kind: 'constant', value: 1 } }, {})).toMatchObject({
      code: 'PROP_MODEL_NOT_FOUND',
    });
    const rational = evaluateForm({ kind: 'nistRational', coefficients: [1, 0, 0, 0, 0, 0, 0, 0, 0] }, { T: 4 }, 'T');
    expect(rational).toEqual({ value: 10, derivative: 0 });
  });
});
