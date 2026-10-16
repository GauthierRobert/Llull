/** fit_at_temperature (PHY-04 TR-TMC-20/21): CSV pairs, VC-TMC-06.*, 09.a, 62, CTE sources, failure codes, purity. */
import { describe, expect, it } from 'vitest';
import { expectCase } from '../benchmarkCases';
import {
  G6,
  H7,
  PACK,
  SPEC_20C,
  csvRows,
  cteModel,
  dataOf,
  emptyDoc,
  explicitCte,
  perK,
  run,
  strainModel,
  withModel,
  type FitData,
} from './thermomechFixtures';

const ALPHA: Record<string, [number, number]> = {};
for (const row of csvRows('fit_at_temperature.csv'))
  ALPHA[row['pair'] ?? ''] = [Number(row['alpha_hole_per_K']), Number(row['alpha_shaft_per_K'])];

const fit = (extra: Record<string, unknown>, doc = emptyDoc()): ReturnType<typeof run> =>
  run(doc, 'fit_at_temperature', { hole: H7, shaft: G6, specTemperature: SPEC_20C, ...extra });

const explicitPair = (alphaHole: number, alphaShaft: number): Record<string, unknown> => ({
  holeCte: explicitCte(alphaHole),
  shaftCte: explicitCte(alphaShaft),
});

const temps = (...values: number[]): { value: number; unit: string }[] => values.map((value) => ({ value, unit: 'degC' }));

describe('fit_at_temperature: fit_at_temperature.csv and VC-TMC-06', () => {
  const rows = csvRows('fit_at_temperature.csv');
  it.each(rows)('reproduces $pair at $T_degC degC (explicit secant CTEs)', (csv) => {
    const result = fit({
      ...explicitPair(Number(csv['alpha_hole_per_K']), Number(csv['alpha_shaft_per_K'])),
      temperatures: temps(Number(csv['T_degC'])),
    });
    const row = dataOf<FitData>(result).rows[0];
    expect(row?.clearance.min).toBeCloseTo(Number(csv['min_clearance_mm']), 9);
    expect(row?.clearance.max).toBeCloseTo(Number(csv['max_clearance_mm']), 9);
    expect(Math.abs((row?.clearance.min ?? 0) - Number(csv['min_clearance_mm']))).toBeLessThan(
      Math.abs(Number(csv['min_clearance_mm'])) * 1e-8 + 1e-12,
    );
    expect(row?.status).toBe(csv['status']);
  });

  it('matches the generator arithmetic to 1e-12 (diameters scaled limit by limit)', () => {
    const [ah = 0, as = 0] = ALPHA['aluminium_housing_steel_shaft'] ?? [];
    const row = dataOf<FitData>(fit({ ...explicitPair(ah, as), temperatures: temps(-55) })).rows[0];
    const holeMin = (20 + 0) * (1 + ah * (-55 - 20));
    const shaftMax = (20 - 0.007) * (1 + as * (-55 - 20));
    expect(Math.abs((row?.clearance.min ?? 0) - (holeMin - shaftMax))).toBeLessThan(1e-12);
  });

  const al = ALPHA['aluminium_housing_steel_shaft'] ?? [0, 0];
  const steelAl = ALPHA['steel_housing_aluminium_shaft'] ?? [0, 0];
  const first = (alphas: [number, number], T: number): FitData['rows'][number] | undefined =>
    dataOf<FitData>(fit({ ...explicitPair(...alphas), temperatures: temps(T) })).rows[0];

  it('VC-TMC-06.a-d', () => {
    const cold = first(al, -55);
    expectCase(PACK, 'VC-TMC-06.a', cold?.clearance.min ?? Number.NaN);
    expect(cold?.status).toBe('interference_possible');
    expect(cold?.code).toBe('TMC_FIT_INTERFERENCE');
    expect(cold?.disposition).toBe('pending_human');
    expectCase(PACK, 'VC-TMC-06.b', first(al, 85)?.clearance.max ?? Number.NaN);
    expect(first(al, 85)?.status).toBe('clearance');
    expect(first(al, 85)?.disposition).toBe('none');
    const hot = first(steelAl, 85);
    expectCase(PACK, 'VC-TMC-06.c', hot?.clearance.min ?? Number.NaN);
    expect(hot?.code).toBe('TMC_FIT_INTERFERENCE');
    const spec = first(al, 20);
    expectCase(PACK, 'VC-TMC-06.d', [spec?.clearance.min ?? Number.NaN, spec?.clearance.max ?? Number.NaN]);
  });

  it('VC-TMC-62: every row flagged for review with formula and unverified rule; 06.a is interference_possible', () => {
    const data = dataOf<FitData>(fit({ ...explicitPair(...al), temperatures: temps(-55, 20, 85) }));
    const unverifiedRule = data.rows.every((row) => row.unverified === row.unverifiedReasons.length > 0 && row.unverified);
    expectCase(PACK, 'VC-TMC-62', {
      'rows[*].reviewRequired': data.rows.every((row) => row.reviewRequired === true),
      'rows[*].provenance.formula': data.rows.every((row) => row.provenance.formula === data.rows[0]?.provenance.formula)
        ? (data.rows[0]?.provenance.formula ?? '')
        : '',
      'rows[*].unverified': unverifiedRule ? "OR of the cte inputs' flags" : 'mismatch',
      'status of VC-TMC-06.a': data.rows[0]?.status ?? '',
    });
    expect(data.provenance.cte.map((c) => c.part)).toEqual(['hole', 'shaft']);
    expect(data.provenance.limits).toHaveLength(2);
    expect(data.intent).toBe('clearance');
    expect(data.intentSource).toBe('derived_from_limits_at_spec_temperature');
    expect(data.unit).toBe('mm');
  });

  it('VC-TMC-09.a: Lame pressure at maximum interference, and hoop stress at the hub bore', () => {
    const result = run(emptyDoc(), 'fit_at_temperature', {
      hole: { nominal: 20, upper: 0.021, lower: 0 },
      shaft: { nominal: 20, upper: 0.035, lower: 0.022 },
      specTemperature: SPEC_20C,
      ...explicitPair(23e-6, 11.5e-6),
      temperatures: temps(20, 85),
      lame: { hubOuterDiameter: 40, hubE: { value: 70000, unit: 'MPa' }, hubNu: 0.33, shaftE: { value: 200, unit: 'GPa' }, shaftNu: 0.3 },
    });
    const data = dataOf<FitData>(result);
    expectCase(PACK, 'VC-TMC-09.a', data.rows[0]?.interferencePressureMPa?.max ?? Number.NaN);
    const pressure = data.rows[0]?.interferencePressureMPa?.max ?? 0;
    expect(data.rows[0]?.hubHoopStressMPa?.max).toBeCloseTo((pressure * (400 + 100)) / (400 - 100), 9);
    expect(data.intent).toBe('interference');
    expect(data.rows[1]?.code).toBe('TMC_FIT_LOOSE');
    expect(data.rows[1]?.status).toBe('clearance_possible');
    expect(data.rows[1]?.interferencePressureMPa?.min).toBe(0);
    expect(data.rows[0]?.unverifiedReasons.join()).toContain('E, nu');
  });
});

describe('fit_at_temperature: CTE sources from material property models', () => {
  const [ah = 0, as = 0] = ALPHA['aluminium_housing_steel_shaft'] ?? [];
  const csvRow = (T: number): { min: number; max: number } => {
    const row = csvRows('fit_at_temperature.csv').find((r) => r['pair'] === 'aluminium_housing_steel_shaft' && Number(r['T_degC']) === T);
    return { min: Number(row?.['min_clearance_mm']), max: Number(row?.['max_clearance_mm']) };
  };

  it('thermalStrain models give the exact secant (PHY-01 section 3.3)', () => {
    let doc = withModel(emptyDoc(), 'al', strainModel(ah));
    doc = withModel(doc, 'steel', strainModel(as, 'typical'));
    const data = dataOf<FitData>(fit({ holeMaterial: 'al', shaftMaterial: 'steel', temperatures: temps(-55) }, doc));
    expect(data.rows[0]?.clearance.min).toBeCloseTo(csvRow(-55).min, 9);
    expect(data.rows[0]?.unverified).toBe(true);
    expect(data.rows[0]?.unverifiedReasons).toContain('basis typical');
    expect(data.provenance.cte[0]?.source).toContain('thermalStrain');
  });

  it('a thermalStrain model with s(T_spec) != 0 uses (s(T) - s(Ts)) / (1 + s(Ts))', () => {
    const doc = withModel(
      withModel(emptyDoc(), 'a', {
        ...strainModel(1e-5),
        form: { kind: 'polynomial', variable: 'T', coefficients: [1e-3, 1e-5], origin: 293.15 },
      }),
      'b',
      strainModel(0),
    );
    const row = dataOf<FitData>(fit({ holeMaterial: 'a', shaftMaterial: 'b', temperatures: temps(120) }, doc)).rows[0];
    expect(row?.provenance.thermalStrain.hole).toBeCloseTo((1e-3 + 1e-5 * 100 - 1e-3) / (1 + 1e-3), 14);
    expect(row?.provenance.thermalStrain.shaft).toBe(0);
  });

  it('a cte model needs its basis: secant re-referenced exactly, instantaneous integrated (law and exact table)', () => {
    let doc = withModel(emptyDoc(), 'al', cteModel({ kind: 'constant', value: ah }));
    doc = withModel(doc, 'steel', cteModel({ kind: 'constant', value: as }));
    const unknown = fit({ holeMaterial: 'al', shaftMaterial: 'steel', temperatures: temps(85) }, doc);
    expect(unknown.error?.code).toBe('TMC_CTE_BASIS_UNKNOWN');
    const secant = { kind: 'secant', referenceTemperature: { value: 0, unit: 'degC' } };
    const data = dataOf<FitData>(
      fit({ holeMaterial: 'al', shaftMaterial: 'steel', cteBasis: { al: secant, steel: secant }, temperatures: temps(85) }, doc),
    );
    expect(data.rows[0]?.clearance.min).toBeCloseTo(csvRow(85).min, 9);
    expect(data.provenance.cte[0]?.conversion).toContain('re-referenced');
    const missingReference = fit(
      { holeMaterial: 'al', shaftMaterial: 'steel', cteBasis: { al: { kind: 'secant' }, steel: secant }, temperatures: temps(85) },
      doc,
    );
    expect(missingReference.error?.code).toBe('TMC_CTE_BASIS_UNKNOWN');

    // instantaneous law alpha0 + alpha1 (T - 293.15): strain over [20, 120] degC = alpha0 dT + alpha1 dT^2 / 2 (Simpson is exact)
    const law = cteModel({ kind: 'polynomial', variable: 'T', coefficients: [2.2e-5, 1e-8], origin: 293.15 });
    const table = cteModel({
      kind: 'table1d',
      variable: 'T',
      points: [
        [200, 2.0e-5],
        [293.15, 2.2e-5],
        [400, 2.4e-5],
      ],
      interpolation: 'linear',
    });
    const lawDoc = withModel(withModel(emptyDoc(), 'law', law), 'tab', table);
    const instantaneous = { kind: 'instantaneous' };
    const out = dataOf<FitData>(
      fit(
        { holeMaterial: 'law', shaftMaterial: 'tab', cteBasis: { law: instantaneous, tab: instantaneous }, temperatures: temps(50) },
        lawDoc,
      ),
    );
    expect(out.rows[0]?.provenance.thermalStrain.hole).toBeCloseTo(2.2e-5 * 30 + (1e-8 * 30 ** 2) / 2, 14);
    expect(out.rows[0]?.provenance.samplingError).toBeLessThan(1e-15);
    const slope = (2.4e-5 - 2.2e-5) / (400 - 293.15);
    const t = 50 + 273.15 - 293.15;
    expect(out.rows[0]?.provenance.thermalStrain.shaft).toBeCloseTo(2.2e-5 * t + (slope * t * t) / 2, 14);
    expect(out.provenance.cte[0]?.conversion).toContain('Simpson');
    expect(out.provenance.cte[1]?.conversion).toContain('exactly');
  });

  it('reports the Simpson error estimate for a non-polynomial instantaneous model', () => {
    const doc = withModel(emptyDoc(), 'ex', cteModel({ kind: 'arrhenius', preFactor: 1e-4, activationEnergyJPerMol: 2000 }));
    const result = fit(
      { holeMaterial: 'ex', shaftCte: explicitCte(1e-5), cteBasis: { ex: { kind: 'instantaneous' } }, temperatures: temps(120) },
      doc,
    );
    const row = dataOf<FitData>(result).rows[0];
    expect(row?.provenance.samplingError).toBeGreaterThanOrEqual(0);
    expect(row?.provenance.samplingError).toBeLessThan(1e-9);
  });

  it('refuses a temperature outside the model range, wrapping the PHY-01 refusal', () => {
    const doc = withModel(withModel(emptyDoc(), 'al', strainModel(ah)), 'steel', strainModel(as));
    const result = fit({ holeMaterial: 'al', shaftMaterial: 'steel', temperatures: temps(500) }, doc);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('TMC_PROPERTY_OUT_OF_RANGE');
    expect(dataOf<{ cause: { code: string } }>(result).cause.code).toBe('PROP_OUT_OF_RANGE');
    expect(result.document).toBe(doc);
    const specOut = run(doc, 'fit_at_temperature', {
      hole: H7,
      shaft: G6,
      specTemperature: { value: 500, unit: 'K' },
      holeMaterial: 'al',
      shaftMaterial: 'steel',
      temperatures: temps(20),
    });
    expect(specOut.error?.code).toBe('TMC_PROPERTY_OUT_OF_RANGE');
    const cteRange = withModel(
      withModel(emptyDoc(), 'c', cteModel({ kind: 'constant', value: 1e-5 })),
      'd',
      cteModel({ kind: 'constant', value: 1e-5 }),
    );
    const basis = { kind: 'instantaneous' };
    expect(
      fit({ holeMaterial: 'c', shaftMaterial: 'd', cteBasis: { c: basis, d: basis }, temperatures: temps(500) }, cteRange).error?.code,
    ).toBe('TMC_PROPERTY_OUT_OF_RANGE');
  });

  it('no cte model: TMC_MATERIAL_NO_CTE; unknown material: MAT_RECORD_NOT_FOUND; ambiguous models pass the PHY-01 code', () => {
    let doc = withModel(emptyDoc(), 'steel', strainModel(as));
    doc = run(doc, 'create_material', { name: 'bare', density: 0.001, color: '#ffffff', metalness: 0, roughness: 0.5 }).document;
    expect(fit({ holeMaterial: 'bare', shaftMaterial: 'steel', temperatures: temps(85) }, doc).error?.code).toBe('TMC_MATERIAL_NO_CTE');
    expect(fit({ holeMaterial: 'ghost', shaftMaterial: 'steel', temperatures: temps(85) }, doc).error?.code).toBe('MAT_RECORD_NOT_FOUND');
    const twice = withModel(withModel(doc, 'steel', { ...strainModel(as), id: 'strain2' }), 'bare', strainModel(ah));
    expect(fit({ holeMaterial: 'bare', shaftMaterial: 'steel', temperatures: temps(85) }, twice).error?.code).toBe(
      'PROP_NO_MODEL_FOR_PROPERTY',
    );
    const ambiguousCte = withModel(withModel(twice, 'bare2', cteModel({ kind: 'constant', value: 1e-5 })), 'bare2', {
      ...cteModel({ kind: 'constant', value: 2e-5 }),
      id: 'cte2',
    });
    expect(fit({ holeMaterial: 'bare2', shaftMaterial: 'bare', temperatures: temps(85) }, ambiguousCte).error?.code).toBe(
      'PROP_NO_MODEL_FOR_PROPERTY',
    );
  });
});

describe('fit_at_temperature: inputs, temperatures, intent and failure paths', () => {
  const pair = explicitPair(23e-6, 11.5e-6);
  const code = (
    extra: Record<string, unknown>,
    base: Record<string, unknown> = { ...pair, temperatures: temps(85) },
  ): string | undefined => {
    const doc = emptyDoc();
    const result = run(doc, 'fit_at_temperature', { hole: H7, shaft: G6, specTemperature: SPEC_20C, ...base, ...extra });
    if (result.rejected !== true) return 'accepted';
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    return result.error?.code;
  };

  it('VC-TMC-60 (fit side): the specification temperature is mandatory and never defaulted', () => {
    expect(code({ specTemperature: undefined })).toBe('TMC_SPEC_TEMPERATURE_MISSING');
    expect(code({ specTemperature: { value: 20, unit: 'MPa' } })).toBe('MAT_UNIT_DIMENSION');
  });

  it('limits, pairing, ordering, CTE source and temperatures failures', () => {
    expect(code({ hole: undefined })).toBe('TMC_FIT_LIMITS_MISSING');
    expect(code({ shaft: undefined })).toBe('TMC_FIT_LIMITS_MISSING');
    expect(code({ shaft: { nominal: 20, upper: -0.02, lower: -0.007 } })).toBe('TMC_FIT_LIMITS_MISSING');
    expect(code({ shaft: { nominal: 25, upper: 0, lower: -0.01 } })).toBe('TMC_FIT_NOT_A_PAIR');
    expect(code({ holeCte: undefined })).toBe('TMC_MATERIAL_NO_CTE');
    expect(code({ holeMaterial: 'x' })).toBe('TMC_CTE_SOURCE_CONFLICT');
    expect(code({ temperatures: undefined })).toBe('TMC_FIT_TEMPERATURES_MISSING');
    expect(code({ holeTemperatures: temps(20, 30), shaftTemperatures: temps(20) })).toBe('TMC_FIT_TEMPERATURES_MISSING');
    expect(code({ range: { min: { value: 0, unit: 'degC' }, max: { value: 100, unit: 'degC' }, steps: 500 } })).toBe('CMD_INVALID_PARAMS');
    expect(code({ range: { min: { value: 0, unit: 'degC' }, max: { value: 10, unit: 'mm' }, steps: 3 } })).toBe('MAT_UNIT_DIMENSION');
    expect(code({ temperatures: [{ value: 5, unit: 'mm' }] })).toBe('MAT_UNIT_DIMENSION');
    expect(code({ holeCte: { alpha: { value: 1, unit: 'MPa' }, referenceTemperature: SPEC_20C } })).toBe('MAT_UNIT_DIMENSION');
    expect(code({ holeCte: { alpha: perK(1e-5), referenceTemperature: { value: 1, unit: 'mm' } } })).toBe('MAT_UNIT_DIMENSION');
    expect(code({ cteBasis: { al: { kind: 'secant', referenceTemperature: { value: 1, unit: 'mm' } } } })).toBe('MAT_UNIT_DIMENSION');
    expect(
      code({
        lame: { hubOuterDiameter: 10, hubE: { value: 7e4, unit: 'MPa' }, hubNu: 0.3, shaftE: { value: 2e5, unit: 'MPa' }, shaftNu: 0.3 },
      }),
    ).toBe('TMC_FIT_LIMITS_MISSING');
    expect(
      code({
        lame: { hubOuterDiameter: 40, hubE: { value: 7e4, unit: 'mm' }, hubNu: 0.3, shaftE: { value: 2e5, unit: 'MPa' }, shaftNu: 0.3 },
      }),
    ).toBe('MAT_UNIT_DIMENSION');
  });

  it('refuses oversized temperature requests before generating any row', () => {
    const range = (steps: number): Record<string, unknown> => ({
      range: { min: { value: 0, unit: 'degC' }, max: { value: 100, unit: 'degC' }, steps },
    });
    expect(code(range(1e9))).toBe('CMD_INVALID_PARAMS');
    expect(code(range(201))).toBe('CMD_INVALID_PARAMS');
    expect(code({ ...range(150), temperatures: temps(...Array.from({ length: 60 }, (_, i) => i)) })).toBe('TMC_FIT_TEMPERATURES_MISSING');
    const many = temps(...Array.from({ length: 201 }, (_, i) => i));
    expect(code({ holeTemperatures: many, shaftTemperatures: many })).toBe('TMC_FIT_TEMPERATURES_MISSING');
  });

  it('range, per-part temperatures, given intent and the summary', () => {
    const range = dataOf<FitData>(
      fit({ ...pair, range: { min: { value: -55, unit: 'degC' }, max: { value: 85, unit: 'degC' }, steps: 3 } }),
    );
    expect(range.rows.map((row) => row.temperature.hole.value)).toEqual([-55, 15, 85]);
    const split = dataOf<FitData>(fit({ ...pair, holeTemperatures: temps(85), shaftTemperatures: [{ value: 300, unit: 'K' }] }));
    expect(split.rows).toHaveLength(1);
    expect(split.rows[0]?.temperature.shaft.unit).toBe('K');
    const forced = fit({ ...pair, intent: 'interference', temperatures: temps(20) });
    const data = dataOf<FitData>(forced);
    expect(data.intentSource).toBe('given');
    expect(data.rows[0]?.code).toBe('TMC_FIT_LOOSE');
    expect(data.rows[0]?.status).toBe('clearance');
    expect(forced.summary).toContain('TMC_FIT_LOOSE');
    expect(forced.summary).toContain('review');
    const inches = run({ ...emptyDoc(), units: 'in' }, 'fit_at_temperature', {
      hole: H7,
      shaft: G6,
      specTemperature: SPEC_20C,
      ...pair,
      temperatures: temps(20),
    });
    expect(dataOf<FitData>(inches).unit).toBe('in');
  });

  it('transition fits and interference fits derive their intent and status', () => {
    const transition = dataOf<FitData>(fit({ ...pair, shaft: { nominal: 20, upper: 0.01, lower: -0.01 }, temperatures: temps(20, 85) }));
    expect(transition.intent).toBe('transition');
    expect(transition.rows.map((row) => row.status)).toEqual(['interference_possible', 'clearance']);
    expect(transition.rows.every((row) => row.code === undefined && row.disposition === 'none')).toBe(true);
    const press = dataOf<FitData>(fit({ ...pair, shaft: { nominal: 20, upper: 0.035, lower: 0.022 }, temperatures: temps(20) }));
    expect(press.intent).toBe('interference');
    expect(press.rows[0]?.status).toBe('interference');
  });

  it('is pure and read-only', () => {
    const doc = withModel(emptyDoc(), 'al', strainModel(23e-6));
    const snapshot = structuredClone(doc);
    const result = fit({ holeMaterial: 'al', shaftCte: explicitCte(1e-5), temperatures: temps(85) }, doc);
    expect(doc).toEqual(snapshot);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBeUndefined();
  });
});
