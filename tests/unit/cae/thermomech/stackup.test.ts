/** PHY-04 M4b: stackup_at_temperature (the at-temperature dimension chain; closed forms from the 03 GDT stack-up model, PMI-linked contributors). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../../helpers/pmiPlateKernel';
import { cteModel, strainModel, withModel } from '../../physics/thermomech/thermomechFixtures';

const SPEC = { value: 20, unit: 'degC' };
const cte = (alpha: number): Record<string, unknown> => ({
  alpha: { value: alpha, unit: '1/K' },
  referenceTemperature: SPEC,
  source: 'datasheet',
});

/** Housing bore depth 50 +-0.05 (aluminium, 23e-6), shaft length 49.5 +-0.03 (steel, 12e-6): gap = depth - length. */
const CHAIN = [
  { name: 'housing depth', nominal: 50, upper: 0.05, lower: -0.05, sensitivity: 1, cte: cte(23e-6) },
  { name: 'shaft length', nominal: 49.5, upper: 0.03, lower: -0.03, sensitivity: -1, cte: cte(12e-6) },
];

interface Data {
  unit: string;
  specRow: Row;
  rows: Row[];
  provenance: { sigmaPerHalfTolerance: { value: number; defaulted: boolean }; cte: { contributor: string; source: string }[] };
  assumptions: string[];
}
interface Row {
  temperatureKelvin: number;
  mean: number;
  worstCase: { min: number; max: number; halfTolerance: number };
  rss: { sigma: number; min: number; max: number; halfRange: number };
  shiftFromSpec: number;
  contributions: { name: string; wcPercent: number; rssPercent: number; thermalStrain: number }[];
  status?: string;
  code?: string;
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
  disposition: string;
}

const run = (params: Record<string, unknown>, doc = createEmptyDocument()): ReturnType<typeof execute> =>
  execute(doc, 'stackup_at_temperature', {
    contributors: CHAIN,
    specTemperature: SPEC,
    temperatures: [{ value: 100, unit: 'degC' }],
    ...params,
  });

describe('stackup_at_temperature', () => {
  it('scales every contributor with its own CTE and combines worst case and RSS (closed form)', () => {
    const result = run({
      temperatures: [
        { value: 20, unit: 'degC' },
        { value: 100, unit: 'degC' },
      ],
    });
    const data = result.data as Data;
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([]);
    expect(data.rows).toHaveLength(2);
    expect(data.specRow.mean).toBeCloseTo(0.5, 12);
    expect(data.specRow.worstCase.halfTolerance).toBeCloseTo(0.08, 12);
    expect(data.rows[0]?.shiftFromSpec).toBeCloseTo(0, 12);
    const hot = data.rows[1];
    const housing = 1 + 23e-6 * 80;
    const shaft = 1 + 12e-6 * 80;
    expect(hot?.mean).toBeCloseTo(50 * housing - 49.5 * shaft, 12);
    expect(hot?.shiftFromSpec).toBeCloseTo(50 * housing - 49.5 * shaft - 0.5, 12);
    const wc = 0.05 * housing + 0.03 * shaft;
    expect(hot?.worstCase.halfTolerance).toBeCloseTo(wc, 12);
    expect(hot?.worstCase.min).toBeCloseTo((hot?.mean ?? 0) - wc, 12);
    const rss = Math.sqrt((0.05 * housing) ** 2 + (0.03 * shaft) ** 2);
    expect(hot?.rss.halfRange).toBeCloseTo(rss, 12);
    expect(hot?.rss.sigma).toBeCloseTo(rss / 3, 12);
    expect(hot?.contributions.map((entry) => entry.name)).toEqual(['housing depth', 'shaft length']);
    const percent = hot?.contributions.reduce((sum, entry) => sum + entry.wcPercent, 0) ?? 0;
    expect(percent).toBeCloseTo(100, 10);
    expect(hot?.contributions.reduce((sum, entry) => sum + entry.rssPercent, 0)).toBeCloseTo(100, 10);
    expect(hot?.contributions[0]?.thermalStrain).toBeCloseTo(23e-6 * 80, 15);
    expect(data.provenance.sigmaPerHalfTolerance).toMatchObject({ value: 3, defaulted: true });
    expect(data.provenance.cte.map((entry) => entry.source)).toEqual([
      'explicit secant CTE (datasheet)',
      'explicit secant CTE (datasheet)',
    ]);
    expect(result.summary).toContain('2 contributor(s), 2 temperature(s)');
    expect(result.summary).toContain('no spec limit given');
  });

  it('flags every row for review and the typed / explicit inputs as unverified, unless the limits are marked verified', () => {
    const data = run({}).data as Data;
    expect(data.rows[0]?.reviewRequired).toBe(true);
    expect(data.rows[0]?.unverified).toBe(true);
    expect(data.rows[0]?.unverifiedReasons).toEqual([
      'housing depth: explicit CTE without a sourced material record',
      'housing depth: typed limits, not confirmed against their source',
      'shaft length: explicit CTE without a sourced material record',
      'shaft length: typed limits, not confirmed against their source',
    ]);
    const verified = run({ contributors: CHAIN.map((entry) => ({ ...entry, verified: true })) }).data as Data;
    expect(verified.rows[0]?.unverifiedReasons.every((reason) => reason.includes('explicit CTE'))).toBe(true);
    expect(data.assumptions.join(' ')).toContain('lib/stackup.ts');
  });

  it('judges the spec limits: within worst case, within RSS only (TMC_STACKUP_WC_EXCEEDED), outside (TMC_STACKUP_OUT_OF_SPEC)', () => {
    const within = (run({ lowerSpecLimit: 0.4, upperSpecLimit: 0.7 }).data as Data).rows[0];
    expect(within?.status).toBe('within_worst_case');
    expect(within?.code).toBeUndefined();
    expect(within?.disposition).toBe('none');
    const rssOnly = (run({ lowerSpecLimit: 0.44, temperatures: [SPEC] }).data as Data).rows[0];
    expect(rssOnly?.status).toBe('within_rss_only');
    expect(rssOnly?.code).toBe('TMC_STACKUP_WC_EXCEEDED');
    expect(rssOnly?.disposition).toBe('pending_human');
    const result = run({ lowerSpecLimit: 0.5, upperSpecLimit: 0.6 });
    const outside = (result.data as Data).rows[0];
    expect(outside?.status).toBe('outside');
    expect(outside?.code).toBe('TMC_STACKUP_OUT_OF_SPEC');
    expect(result.summary).toContain('1 row(s) flagged TMC_STACKUP_OUT_OF_SPEC (pending human disposition)');
    expect((run({ upperSpecLimit: 0.52 }).data as Data).rows[0]?.status).toBe('outside');
    expect(run({ lowerSpecLimit: 0.1, upperSpecLimit: 0.9 }).summary).toContain('no row violates the spec limits');
  });

  it('reads the CTE of a document material (thermalStrain preferred; a cte model needs its basis)', () => {
    let doc = withModel(createEmptyDocument(), 'alu', strainModel(23e-6));
    doc = withModel(doc, 'steel', cteModel({ kind: 'constant', value: 12e-6 }));
    const contributors = [
      { name: 'housing depth', nominal: 50, upper: 0.05, lower: -0.05, material: 'alu' },
      { name: 'shaft length', nominal: 49.5, upper: 0.03, lower: -0.03, sensitivity: -1, material: 'steel' },
    ];
    const unstated = run({ contributors }, doc);
    expect(unstated.error?.code).toBe('TMC_CTE_BASIS_UNKNOWN');
    expect(unstated.document).toBe(doc);
    const stated = run({ contributors, cteBasis: { steel: { kind: 'secant', referenceTemperature: SPEC } } }, doc);
    const hot = (stated.data as Data).rows[0];
    expect(hot?.mean).toBeCloseTo(50 * (1 + 23e-6 * 80) - 49.5 * (1 + 12e-6 * 80), 10);
    expect(hot?.unverifiedReasons.every((reason) => reason.includes('typed limits'))).toBe(true);
    const instantaneous = run({ contributors, cteBasis: { steel: { kind: 'instantaneous' } } }, doc);
    expect(instantaneous.rejected).not.toBe(true);
    const noReference = run({ contributors, cteBasis: { steel: { kind: 'secant' } } }, doc);
    expect(noReference.error?.code).toBe('TMC_CTE_BASIS_UNKNOWN');
  });

  it('refuses a temperature outside the validity of a material model (TMC_PROPERTY_OUT_OF_RANGE) and unknown materials', () => {
    const doc = withModel(createEmptyDocument(), 'alu', strainModel(23e-6));
    const contributors = [{ name: 'housing depth', nominal: 50, upper: 0.05, lower: -0.05, material: 'alu' }];
    expect(run({ contributors, temperatures: [{ value: 400, unit: 'degC' }] }, doc).error?.code).toBe('TMC_PROPERTY_OUT_OF_RANGE');
    expect(run({ contributors: [{ ...contributors[0], material: 'nope' }] }, doc).error?.code).toBe('MAT_RECORD_NOT_FOUND');
  });

  it('refuses bad input with a coded rejection and the unchanged document', () => {
    const doc = createEmptyDocument();
    const wrong = (params: Record<string, unknown>, code: string): void => {
      const result = run(params, doc);
      expect(result.error?.code).toBe(code);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    };
    wrong({ specTemperature: undefined }, 'TMC_SPEC_TEMPERATURE_MISSING');
    wrong({ specTemperature: { value: 20, unit: 'mm' } }, 'THM_UNITS_MISMATCH');
    wrong({ specTemperature: { value: -300, unit: 'degC' } }, 'THM_UNITS_MISMATCH');
    wrong({ temperatures: [] }, 'TMC_FIT_TEMPERATURES_MISSING');
    wrong({ temperatures: Array.from({ length: 51 }, () => SPEC) }, 'TMC_FIT_TEMPERATURES_MISSING');
    wrong({ temperatures: [{ value: -300, unit: 'degC' }] }, 'THM_UNITS_MISMATCH');
    wrong({ temperatures: [{ value: 5, unit: 'mm' }] }, 'THM_UNITS_MISMATCH');
    wrong({ contributors: [] }, 'TMC_STACKUP_INVALID');
    wrong({ contributors: [CHAIN[0], { ...CHAIN[0] }] }, 'TMC_STACKUP_INVALID');
    wrong({ contributors: [{ ...CHAIN[0], upper: -1 }] }, 'TMC_FIT_LIMITS_MISSING');
    wrong({ contributors: [{ ...CHAIN[0], sensitivity: 0 }] }, 'TMC_FIT_LIMITS_MISSING');
    wrong({ contributors: [{ ...CHAIN[0], nominal: 0 }] }, 'TMC_FIT_LIMITS_MISSING');
    wrong({ lowerSpecLimit: 2, upperSpecLimit: 1 }, 'TMC_STACKUP_INVALID');
    wrong({ contributors: [{ name: 'x', nominal: 1, upper: 0, lower: 0 }] }, 'TMC_MATERIAL_NO_CTE');
    wrong({ contributors: [{ ...CHAIN[0], material: 'alu' }] }, 'TMC_CTE_SOURCE_CONFLICT');
    wrong({ contributors: [{ ...CHAIN[0], cte: { ...cte(1e-5), alpha: { value: 1, unit: 'mm' } } }] }, 'THM_UNITS_MISMATCH');
    wrong({ contributors: Array.from({ length: 51 }, (_, i) => ({ ...CHAIN[0], name: `c${i}` })) }, 'TMC_STACKUP_INVALID');
  });

  it('takes nominal and limits from a linked 03 PMI dimension (verified by default) and refuses a bad link', () => {
    setGeometryKernel(plateKernel());
    try {
      const box = execute(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
      const entityId = box.affected[0] as string;
      const bore = execute(box.document, 'add_size_dimension', {
        entityId,
        facesNear: [[50, 40, 6]],
        sizeKind: 'diameter',
        tolerance: { type: 'plusMinus', upper: 0.021, lower: 0 },
      });
      const basic = execute(bore.document, 'add_size_dimension', {
        entityId,
        facesNear: [[16.7, 20, 6]],
        sizeKind: 'diameter',
        tolerance: { type: 'basic' },
      });
      const [boreId, basicId] = [bore.affected[0], basic.affected[0]] as string[];
      const doc = basic.document;
      const linked = run({ contributors: [{ name: 'bore', pmiId: boreId, cte: cte(23e-6), sensitivity: 1 }] }, doc);
      const data = linked.data as Data;
      expect(linked.rejected).not.toBe(true);
      expect(data.specRow.mean).toBeCloseTo(20.0105, 9);
      expect(data.specRow.worstCase.halfTolerance).toBeCloseTo(0.0105, 9);
      expect(data.specRow.unverifiedReasons.join(' ')).not.toContain('typed limits');
      const code = (contributor: Record<string, unknown>): string | undefined =>
        (run({ contributors: [{ name: 'x', cte: cte(1e-5), ...contributor }] }, doc).data as { code?: string }).code;
      expect(code({ pmiId: 'ghost' })).toBe('TMC_STACKUP_INVALID');
      expect(code({ pmiId: basicId })).toBe('TMC_STACKUP_INVALID');
      expect(code({ nominal: 1 })).toBe('TMC_STACKUP_INVALID');
      const unconfirmed = run({ contributors: [{ name: 'bore', pmiId: boreId, cte: cte(23e-6), verified: false }] }, doc).data as Data;
      expect(unconfirmed.specRow.unverifiedReasons.join(' ')).toContain('typed limits');
    } finally {
      setGeometryKernel(null);
    }
  });

  it('is pure: the document is untouched and the result is deterministic', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    const first = run({}, doc);
    expect(first.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(run({}, doc).data).toEqual(first.data);
  });
});
