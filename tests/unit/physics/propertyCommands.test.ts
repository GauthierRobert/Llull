/** PHY-01 commands: define / remove (happy, failure, purity), error codes, fit, sampling, check, persistence (VC-PROP-09, 13, 14, 18…21). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { GAS_CONSTANT } from '@core/model/propertyForms';
import { sha256Hex } from '@lib/sha256';
import { expectCase, packCase } from './benchmarkCases';
import { NIST_FITS, PACK, nistDocument, nistModel, withMaterial } from './propertyFixtures';

const doc = nistDocument();
const k6061 = nistModel('aa6061_t6.k');
const source = { citation: 'synthetic', locator: 'test' };

const codeOf = (document: CadDocument, command: string, params: Record<string, unknown>): string => {
  const result = execute(document, command, params);
  expect(result.document, `${command} must not change the document`).toBe(document);
  return result.error?.code ?? 'accepted';
};

describe('define_property_model / remove_property_model', () => {
  it('adds a model with a recomputed hash, records a step and is pure', () => {
    const base = withMaterial(createEmptyDocument(), 'al');
    const snapshot = structuredClone(base);
    const result = execute(base, 'define_property_model', { material: 'al', model: { ...k6061, coefficientsSha256: 'forged' } });
    expect(base).toEqual(snapshot);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/define_property_model 'al\/k': k \[W\/\(m\*K\)\] as log10Polynomial/);
    const model = result.document.materials['al']?.propertyModels?.[0];
    expect(model?.coefficientsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(model?.coefficientsSha256).not.toBe('forged');
    expect(result.document.featureHistory.at(-1)?.name).toBe('define_property_model');
    const replaced = execute(result.document, 'define_property_model', {
      material: 'al',
      model: { ...k6061, basis: 'company' },
      replace: true,
    });
    expect(replaced.document.materials['al']?.propertyModels?.map((m) => m.basis)).toEqual(['company']);
    const recreated = execute(replaced.document, 'create_material', {
      name: 'al',
      density: 0.0028,
      color: '#aaaaaa',
      metalness: 1,
      roughness: 0.3,
    });
    expect(recreated.document.materials['al']?.propertyModels).toHaveLength(1);
    const removed = execute(recreated.document, 'remove_property_model', { material: 'al', modelId: 'k' });
    expect(removed.document.materials['al']?.propertyModels).toEqual([]);
  });

  it('refuses malformed models with stable codes and paths', () => {
    const base = withMaterial(createEmptyDocument(), 'al');
    const define = (model: Record<string, unknown>, material = 'al'): string => codeOf(base, 'define_property_model', { material, model });
    expect(define(k6061, 'nope')).toBe('MAT_RECORD_NOT_FOUND');
    expect(define({ ...k6061, form: { kind: 'nistRational', coefficients: [1, 2, 3, 4, 5, 6, 7, 8] } })).toBe('PROP_FORM_INVALID');
    expect(
      define({
        ...k6061,
        form: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [100, 1],
            [50, 2],
          ],
          interpolation: 'linear',
        },
      }),
    ).toBe('PROP_TABLE_NOT_MONOTONIC');
    expect(
      define({
        ...k6061,
        form: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [100, -1],
            [150, 2],
          ],
          interpolation: 'loglog',
        },
      }),
    ).toBe('PROP_TABLE_NOT_MONOTONIC');
    expect(define({ ...k6061, form: { kind: 'wobble' } })).toBe('PROP_FORM_INVALID');
    expect(define({ ...k6061, unit: 'MPa' })).toBe('MAT_UNIT_DIMENSION');
    expect(define({ ...k6061, unit: 'W/(furlong*K)' })).toBe('MAT_UNIT_INVALID');
    expect(define({ ...k6061, property: 'luck' })).toBe('PROP_PROPERTY_UNKNOWN');
    expect(define({ ...k6061, validity: [{ variable: 'T', unit: 'K', data: [4, 300], equation: [10, 300] }] })).toBe('PROP_RANGE_INVALID');
    expect(define({ ...k6061, validity: [] })).toBe('PROP_RANGE_INVALID');
    expect(define({ ...k6061, validity: [{ variable: 'T', unit: 'MPa', data: [4, 300] }] })).toBe('MAT_UNIT_DIMENSION');
    expect(define({ ...k6061, variables: [] })).toBe('PROP_FORM_INVALID');
    expect(define({ ...k6061, source: { citation: undefined } })).not.toBe('accepted');
    expect(define({ ...k6061, form: { kind: 'ratioOf', baseModelId: 'missing', ratio: { kind: 'constant', value: 1 } } })).toBe(
      'PROP_FORM_INVALID',
    );
    expect(define({ ...k6061, fit: { method: 'magic' } })).toBe('PROP_FORM_INVALID');
    expect(define({ ...k6061, condition: { rrr: 'high' } })).toBe('PROP_FORM_INVALID');
    expect(define({ ...k6061, condition: { colour: 'red' } })).toBe('PROP_FORM_INVALID');
    const once = execute(base, 'define_property_model', { material: 'al', model: { ...k6061, preferred: true } }).document;
    expect(codeOf(once, 'define_property_model', { material: 'al', model: k6061 })).toBe('PROP_MODEL_EXISTS');
    expect(codeOf(once, 'define_property_model', { material: 'al', model: { ...k6061, id: 'k2', preferred: true } })).toBe(
      'MAT_PREFERRED_CONFLICT',
    );
    expect(codeOf(once, 'remove_property_model', { material: 'al', modelId: 'zz' })).toBe('PROP_MODEL_NOT_FOUND');
    expect(codeOf(once, 'remove_property_model', { material: 'zz', modelId: 'k' })).toBe('MAT_RECORD_NOT_FOUND');
  });

  it('returns the stable codes of VC-PROP-19', () => {
    const density = withMaterial(createEmptyDocument(), 'steel');
    const codes = [
      codeOf(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'k', at: { T: { value: 400, unit: 'K' } } }),
      codeOf(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'k', at: {} }),
      codeOf(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'k', at: { T: { value: 77, unit: 'MPa' } } }),
      codeOf(withMaterial(createEmptyDocument(), 'x'), 'define_property_model', {
        material: 'x',
        model: { ...k6061, form: { kind: 'nistRational', coefficients: [1, 2, 3, 4, 5, 6, 7, 8] } },
      }),
      codeOf(withMaterial(createEmptyDocument(), 'x'), 'define_property_model', {
        material: 'x',
        model: {
          ...k6061,
          form: {
            kind: 'table1d',
            variable: 'T',
            points: [
              [300, 1],
              [4, 2],
            ],
            interpolation: 'linear',
          },
        },
      }),
      codeOf(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'G', at: { T: { value: 77, unit: 'K' } } }),
      codeOf(density, 'evaluate_property', { material: 'steel', property: 'density', at: { T: { value: 77, unit: 'K' } } }),
      codeOf(doc, 'fit_property_model', {
        data: {
          variable: 'T',
          variableUnit: 'K',
          valueUnit: 'W/(m*K)',
          rows: [
            [4, 1],
            [5, 2],
            [6, 3],
          ],
        },
        form: 'log10Polynomial',
        degree: 7,
        property: 'k',
        id: 'k.fit',
      }),
    ];
    expectCase(PACK, 'VC-PROP-19/errorCodes', codes);
    const refused = execute(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'k', at: { T: { value: 400, unit: 'K' } } });
    expect(refused.error).toMatchObject({ paths: ['at.T'] });
    expect((refused.data as { validity: unknown[] }).validity).toHaveLength(1);
    expect(codeOf(doc, 'evaluate_property', { material: 'nope', property: 'k', at: {} })).toBe('MAT_RECORD_NOT_FOUND');
    expect(
      codeOf(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'k', at: { T: { value: 77, unit: 'K' } }, outputUnit: 'MPa' }),
    ).toBe('MAT_UNIT_DIMENSION');
    expect(codeOf(doc, 'evaluate_property', { material: 'cu_ofhc', property: 'k', at: { T: { value: 77, unit: 'K' } } })).toBe(
      'PROP_NO_MODEL_FOR_PROPERTY',
    );
    const scalar = execute(density, 'evaluate_property', {
      material: 'steel',
      property: 'density',
      at: { T: { value: 77, unit: 'K' } },
      allowConstant: true,
      outputUnit: 'kg/m^3',
    });
    expect(scalar.data).toMatchObject({ value: 2700, unit: 'kg/m^3', unverified: true, defaults: [{ name: 'allowConstant' }] });
  });
});

describe('fit_property_model (VC-PROP-13, 14)', () => {
  it('refits the 6061-T6 k fit with a degree-7 log10 polynomial', () => {
    const temps = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300];
    const rows = temps.map((t) => [
      t,
      (
        execute(doc, 'evaluate_property', { material: 'aa6061_t6', property: 'k', at: { T: { value: t, unit: 'K' } } }).data as {
          value: number;
        }
      ).value,
    ]);
    const result = execute(doc, 'fit_property_model', {
      data: { variable: 'T', variableUnit: 'K', valueUnit: 'W/(m*K)', rows },
      form: 'log10Polynomial',
      degree: 7,
      property: 'k',
      id: 'k.refit',
    });
    expect(result.document).toBe(doc);
    const data = result.data as {
      model: { form: { coefficients: number[] }; validity: unknown };
      fit: { residual: { maxRel: number }; datasetSha256: string };
      warnings: unknown[];
    };
    expectCase(PACK, 'VC-PROP-13/refit6061k/maxRelError', data.fit.residual.maxRel);
    expectCase(PACK, 'VC-PROP-13/refit6061k/coefficients', data.model.form.coefficients);
    expect(data.model.validity).toEqual([{ variable: 'T', unit: 'K', data: [4, 300] }]);
    expect(data.warnings).toEqual([]);
    const accepted = execute(withMaterial(createEmptyDocument(), 'al'), 'define_property_model', { material: 'al', model: data.model });
    expect(accepted.rejected).toBeUndefined();
    const certified = execute(accepted.document, 'evaluate_property', {
      material: 'al',
      property: 'k',
      at: { T: { value: 77, unit: 'K' } },
      forCertification: true,
    });
    expect(certified.error?.code).toBe('MAT_VALUE_UNVERIFIED');
    expect(certified.data).toMatchObject({ reviewRequired: true });
    const check = execute(accepted.document, 'check_property_models', {}).data as {
      items: { code: string }[];
      unverified: { reasons: string[] }[];
    };
    expect(check.items.map((i) => i.code)).toContain('PROP_FIT_UNREVIEWED');
    expect(check.unverified[0]?.reasons).toEqual(['basis unspecified', 'fit without data provenance', 'fit not reviewed']);
  });

  it('fits Arrhenius parameters, polynomials, power laws and tables; flags poor fits', () => {
    const rows = [500, 600, 700, 800, 900, 1000].map((t) => [t, 1e-3 * Math.exp(-150e3 / (GAS_CONSTANT * t))]);
    const fit = (params: Record<string, unknown>): CommandResult =>
      execute(doc, 'fit_property_model', { property: 'diffusionRate', id: 'r', ...params });
    const arrhenius = fit({ data: { variable: 'T', variableUnit: 'K', valueUnit: '1/s', rows }, form: 'arrhenius', dataSource: source })
      .data as { model: { form: { preFactor: number; activationEnergyJPerMol: number } } };
    expectCase(PACK, 'VC-PROP-14/arrheniusFit/Q', arrhenius.model.form.activationEnergyJPerMol);
    expectCase(PACK, 'VC-PROP-14/arrheniusFit/A', arrhenius.model.form.preFactor);
    const line = [
      [1, 3],
      [2, 5],
      [3, 7],
      [4, 9.5],
    ];
    const poly = fit({
      property: 'k',
      data: { variable: 'T', variableUnit: 'K', valueUnit: 'W/(m*K)', rows: line },
      form: 'polynomial',
      degree: 1,
      objective: 'relative',
      maxRelResidual: 0.001,
    }).data as { warnings: { code: string }[]; model: { form: { coefficients: number[] } } };
    expect(poly.warnings[0]?.code).toBe('PROP_FIT_POOR');
    expect(poly.model.form.coefficients).toHaveLength(2);
    const power = fit({
      property: 'k',
      data: {
        variable: 'T',
        variableUnit: 'K',
        valueUnit: 'W/(m*K)',
        rows: [
          [1, 2],
          [2, 16],
          [4, 128],
        ],
      },
      form: 'powerLaw',
    }).data as { model: { form: { exponent: number; coefficient: number } } };
    expect(power.model.form.exponent).toBeCloseTo(3, 12);
    expect(power.model.form.coefficient).toBeCloseTo(2, 12);
    const table = fit({
      property: 'k',
      data: {
        variable: 'T',
        variableUnit: 'K',
        valueUnit: 'W/(m*K)',
        rows: [
          [1, 2],
          [2, 3],
        ],
      },
      form: 'table1d',
    }).data as { fit: { method: string } };
    expect(table.fit.method).toBe('interpolating');
    const refuse = (params: Record<string, unknown>): string | undefined => fit({ property: 'k', ...params }).error?.code;
    const data = (r: number[][]): Record<string, unknown> => ({ variable: 'T', variableUnit: 'K', valueUnit: 'W/(m*K)', rows: r });
    expect(
      refuse({
        data: data([
          [1, 1],
          [1, 2],
          [3, 3],
        ]),
        form: 'polynomial',
        degree: 1,
      }),
    ).toBe('PROP_FIT_DATA_INVALID');
    expect(
      refuse({
        data: data([
          [1, -1],
          [2, 2],
          [3, 3],
        ]),
        form: 'powerLaw',
      }),
    ).toBe('PROP_FIT_DATA_INVALID');
    expect(
      refuse({
        data: data([
          [1, 1, 0],
          [2, 2],
          [3, 3],
        ]),
        form: 'polynomial',
        degree: 1,
      }),
    ).toBe('PROP_FIT_DATA_INVALID');
    expect(
      refuse({
        data: data([
          [1, 1],
          [2, 2],
          [3, 3],
        ]),
        form: 'log10Polynomial',
        degree: 9,
      }),
    ).toBe('PROP_FORM_INVALID');
    expect(
      refuse({
        data: data([
          [0, 1],
          [1e-7, 1],
          [2e-7, 1],
          [3e-7, 1],
          [1, 2],
        ]),
        form: 'polynomial',
        degree: 3,
      }),
    ).toBe('PROP_FIT_ILL_CONDITIONED');
    expect(
      refuse({
        data: data([
          [1, 1],
          [2, 2],
          [3, 3],
        ]),
        form: 'polynomial',
        degree: 1,
        property: 'luck',
      }),
    ).toBe('PROP_PROPERTY_UNKNOWN');
  });
});

describe('sample_property (VC-PROP-20, 21)', () => {
  const sample = (params: Record<string, unknown>): CommandResult =>
    execute(doc, 'sample_property', {
      material: 'aa6061_t6',
      property: 'k',
      variable: 'T',
      from: { value: 4, unit: 'K' },
      to: { value: 300, unit: 'K' },
      ...params,
    });

  it('integrates the conductivity from 4 K to 300 K', () => {
    for (const [material, caseId] of [
      ['ss304', 'VC-PROP-20/ss304.k/integral4to300K'],
      ['aa6061_t6', 'VC-PROP-20/aa6061_t6.k/integral4to300K'],
    ] as const) {
      const integral = (sample({ material, integrate: true, count: 2 }).data as { integral: { value: number; unit: string } }).integral;
      expectCase(PACK, caseId, integral.value, integral.unit);
    }
    const thermal = sample({ property: 'thermalStrain', integrate: true, count: 3, spacing: 'log' }).data as {
      points: number[][];
      integral: { value: number };
    };
    expect(thermal.points.map((p) => p[0])).toEqual([4, Math.sqrt(1200), 300]);
    expect(Number.isFinite(thermal.integral.value)).toBe(true);
  });

  it('builds a solver table within relTol in at most 60 points', () => {
    const data = sample({ solverTable: true, outputUnit: 'W/(mm*K)' }).data as {
      points: unknown[];
      solverTable: { points: number[][]; maxRelError: number };
      defaults: { name: string }[];
    };
    expect(data.points).toHaveLength(101);
    expect(data.solverTable.points.length).toBeLessThanOrEqual(60);
    expect(data.solverTable.maxRelError).toBeLessThanOrEqual(1e-3);
    expect(data.solverTable.points[0]?.[1]).toBeCloseTo(5.34742389854e-3, 12);
    expect(data.defaults.map((d) => d.name)).toEqual(['count', 'solverTableRelTol']);
    const piecewise = sample({
      material: 'ss304',
      property: 'E',
      from: { value: 5, unit: 'K' },
      to: { value: 293, unit: 'K' },
      solverTable: true,
      solverTableRelTol: 1e-4,
    }).data as { solverTable: { points: number[][] } };
    expect(piecewise.solverTable.points.some((p) => p[0] === 57)).toBe(true);
  });

  it('refuses out-of-range ends, oversize requests and unknown variables', () => {
    expect(sample({ to: { value: 400, unit: 'K' } }).error?.code).toBe('PROP_OUT_OF_RANGE');
    expect(sample({ count: 1001 }).error?.code).toBe('PROP_SAMPLE_TOO_LARGE');
    expect(sample({ from: { value: 300, unit: 'K' }, to: { value: 4, unit: 'K' } }).error?.code).toBe('PROP_OUT_OF_RANGE');
    expect(sample({ variable: 'strainRate' }).error?.code).toBe('PROP_VARIABLE_MISSING');
    expect(sample({ property: undefined }).error?.code).toBe('PROP_NO_MODEL_FOR_PROPERTY');
    expect(sample({ material: 'nope' }).error?.code).toBe('MAT_RECORD_NOT_FOUND');
    expect(sample({ solverTable: true, solverTableRelTol: 1e-15 }).error?.code).toBe('PROP_SAMPLE_TOO_LARGE');
  });
});

describe('check_property_models (VC-PROP-09)', () => {
  it('reports the Invar transcription conflict and the 304 E jump only above its tolerance', () => {
    const check = (
      params: Record<string, unknown> = {},
    ): { status: string; items: { code: string; ids: string[]; values?: Record<string, number> }[] } =>
      execute(doc, 'check_property_models', params).data as {
        status: string;
        items: { code: string; ids: string[]; values?: Record<string, number> }[];
      };
    const all = check();
    expect(all.status).toBe('warn');
    const conflict = all.items.find((i) => i.code === 'PROP_SOURCE_CONFLICT');
    expect(conflict?.ids).toEqual(['invar36/thermalStrain.T1', 'invar36/thermalStrain.T2']);
    expect(all.items.some((i) => i.code === 'PROP_DISCONTINUITY' && i.ids[0] === 'ss304/E')).toBe(false);
    const at300 = (id: string): number =>
      (
        execute(doc, 'evaluate_property', {
          material: 'invar36',
          property: 'thermalStrain',
          modelId: id,
          at: { T: { value: 300, unit: 'K' } },
          outputUnit: '1',
        }).data as { value: number }
      ).value;
    expectCase(PACK, 'VC-PROP-09/invar36/transcriptionConflict@300K', at300('thermalStrain.T1') - at300('thermalStrain.T2'));
    const strict = check({ material: ['ss304'], discontinuityTol: 1e-5 }).items.find((i) => i.code === 'PROP_DISCONTINUITY');
    expectCase(PACK, 'VC-PROP-09/ss304.E/jump@57K', strict?.values?.['jump'] ?? Number.NaN);
    expect(strict?.values?.['relativeJump']).toBeCloseTo(Number(packCase(PACK, 'VC-PROP-09/ss304.E/jump@57K')['relativeJump']), 12);
    expect(check({ material: ['ghost'] }).status).toBe('fail');
  });

  it('flags a positive-only property that is not positive in range', () => {
    let d = withMaterial(createEmptyDocument(), 'bad');
    d = execute(d, 'define_property_model', {
      material: 'bad',
      model: { ...k6061, form: { kind: 'polynomial', variable: 'T', coefficients: [-1, 0.01] } },
    }).document;
    const data = execute(d, 'check_property_models', {}).data as { status: string; items: { code: string }[] };
    expect(data.status).toBe('fail');
    expect(data.items.map((i) => i.code)).toContain('PROP_NONPOSITIVE_IN_RANGE');
  });
});

describe('persistence and hashing', () => {
  it('round-trips property models and rejects a tampered hash', () => {
    const text = serializeDocument(doc);
    const loaded = deserializeDocument(text);
    expect(loaded.materials['aa6061_t6']?.propertyModels).toEqual(doc.materials['aa6061_t6']?.propertyModels);
    const tampered = text.replace(/"coefficientsSha256":"[0-9a-f]{4}/, '"coefficientsSha256":"0000');
    expect(() => deserializeDocument(tampered)).toThrow(/coefficientsSha256/);
    expect(NIST_FITS.size).toBe(13);
  });

  it('computes SHA-256 per FIPS 180-4', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('é'.repeat(40))).toHaveLength(64);
  });
});
