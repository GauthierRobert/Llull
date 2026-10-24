/** Plant 01 PSC M2: `check_pipe_spec` (VC-PSC-10 design conditions, VC-PSC-14 mixed standards, VC-PSC-16 trust and status, §5.6 passes 1 to 9). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { withSpecModel, getSpecModel } from '@aec/plant/spec/store';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { importedDoc, mixSpec, smallSpec, withPipe, type Json } from './specFixture';

interface Issue {
  code: string;
  status: string;
  rule: string;
  ids: string[];
  paths: string[];
  values: Record<string, number | string>;
  message: string;
  remediation: string;
  findingKey: string;
}
interface Checked {
  status: string;
  issues: Issue[];
  counts: { fail: number; warn: number; not_run: number };
  design?: Record<string, unknown>;
  specs: Array<{ specId: string; status: string; sizesChecked: number }>;
  rulesRun: string[];
}

const fixture = importedDoc();
const check = (doc = fixture, params: Json = {}): Checked => data<Checked>(doc, 'check_pipe_spec', { specId: 'CS150-A1', ...params });
const codes = (checked: Checked): string[] => checked.issues.map((issue) => issue.code);
const near = (actual: unknown, expected: number, tolerance: number): void =>
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);

describe('check_pipe_spec design conditions (VC-PSC-10)', () => {
  it('19.0 bar at 45 degC passes the rating: status warn for the draft and unverified data only', () => {
    const checked = check(fixture, { design: { pressureBar: 19, temperatureC: 45 } });
    expect(checked.status).toBe('warn');
    expect(checked.counts.fail).toBe(0);
    expect(codes(checked)).not.toContain('PSC_PT_RATING_EXCEEDED');
    expect(codes(checked)).toEqual(expect.arrayContaining(['PSC_SPEC_NOT_APPROVED', 'PSC_DATA_UNVERIFIED']));
    expect(checked.design).toMatchObject({ checked: true, class: 150, tableId: 'asme-b16.5-group-1.1', method: 'interpolated' });
    near(checked.design?.['ratingBar'], 19.3667, 5e-4);
    near(checked.design?.['marginBar'], 0.3667, 5e-4);
  });

  it('19.5 bar fails PSC_PT_RATING_EXCEEDED first, with rating and margin in bar (-0.133)', () => {
    const checked = check(fixture, { design: { pressure: { value: 19.5, unit: 'bar' }, temperature: { value: 45, unit: 'C' } } });
    expect(checked.status).toBe('fail');
    expect(checked.issues[0]).toMatchObject({ code: 'PSC_PT_RATING_EXCEEDED', status: 'fail', rule: 'design' });
    near(checked.issues[0]?.values['ratingBar'], 19.3667, 5e-4);
    near(checked.issues[0]?.values['marginBar'], -0.1333, 5e-4);
    expect(checked.issues[0]?.remediation.length).toBeGreaterThan(0);
  });

  it('converts psi and MPa gauge pressure and degF', () => {
    const psi = check(fixture, { design: { pressure: { value: 285, unit: 'psi' }, temperature: { value: 113, unit: 'F' } } });
    expect(codes(psi)).toContain('PSC_PT_RATING_EXCEEDED');
    expect(check(fixture, { design: { pressure: { value: 2, unit: 'MPa' }, temperatureC: 45 } }).status).toBe('fail');
    expect(check(fixture, { design: { pressure: { value: 1.9, unit: 'MPa' }, temperatureC: 45 } }).status).toBe('warn');
  });

  it('temperature outside the spec limits fails PSC_TEMPERATURE_LIMIT; outside the table fails PSC_PT_TEMPERATURE_OUT_OF_TABLE', () => {
    const hot = check(fixture, { design: { pressureBar: 5, temperatureC: 250 } });
    expect(codes(hot)).toEqual(expect.arrayContaining(['PSC_TEMPERATURE_LIMIT', 'PSC_PT_TEMPERATURE_OUT_OF_TABLE']));
    const cold = importedDoc({ ...smallSpec(), designLimits: { minTemperatureC: 0 } });
    expect(codes(check(cold, { specId: 'SMALL', design: { pressureBar: 5, temperatureC: -10 } }))).toContain('PSC_TEMPERATURE_LIMIT');
  });

  it('no usable rating table is reported as not_run, never silently passed', () => {
    const en = importedDoc(mixSpec());
    const checked = data<Checked>(en, 'check_pipe_spec', { specId: 'MIX-1', design: { pressureBar: 10, temperatureC: 20 } });
    expect(checked.issues.find((issue) => issue.rule === 'design')).toMatchObject({ code: 'PSC_RATING_TABLE_UNKNOWN', status: 'not_run' });
    expect(checked.design).toMatchObject({ checked: false });
    const noClass = importedDoc({ ...smallSpec(), rating: { system: 'ASME B16.5', materialGroup: '1.1' } });
    expect(
      data<Checked>(noClass, 'check_pipe_spec', { specId: 'SMALL', design: { pressureBar: 5, temperatureC: 20 } }).counts.not_run,
    ).toBe(1);
    const missingClass = importedDoc({ ...smallSpec(), rating: { system: 'ASME B16.5', class: 175, materialGroup: '1.1' } });
    const outcome = data<Checked>(missingClass, 'check_pipe_spec', { specId: 'SMALL', design: { pressureBar: 5, temperatureC: 20 } });
    expect(outcome.design).toMatchObject({ checked: false });
  });

  it('refuses incomplete design conditions: nothing is defaulted', () => {
    expectRefusal(fixture, 'check_pipe_spec', { specId: 'CS150-A1', design: { pressureBar: 10 } }, 'PSC_UNIT_INVALID', 'design');
    expectRefusal(fixture, 'check_pipe_spec', { specId: 'CS150-A1', design: { temperatureC: 10 } }, 'PSC_UNIT_INVALID', 'design');
    expectRefusal(
      fixture,
      'check_pipe_spec',
      { specId: 'CS150-A1', design: { pressureBar: 10, pressure: { value: 1, unit: 'bar' }, temperatureC: 20 } },
      'PSC_UNIT_INVALID',
    );
  });
});

describe('check_pipe_spec trust and status (VC-PSC-16)', () => {
  it('a draft spec warns PSC_SPEC_NOT_APPROVED and unverified data warns PSC_DATA_UNVERIFIED, listing the components', () => {
    const checked = check();
    expect(checked.status).toBe('warn');
    const unverified = checked.issues.find((issue) => issue.code === 'PSC_DATA_UNVERIFIED');
    expect(unverified?.ids).toEqual(expect.arrayContaining(['E90-SW', 'WOL', 'SOL']));
    expect(unverified?.status).toBe('warn');
    expect(codes(checked)).toContain('PSC_SPEC_NOT_APPROVED');
    expect(checked.issues.every((issue) => issue.remediation.length > 0 && issue.findingKey.startsWith('spec:CS150-A1:'))).toBe(true);
  });

  it('an approved spec has no PSC_SPEC_NOT_APPROVED; the unverified warning stays (not suppressible)', () => {
    const model = getSpecModel(fixture);
    const approved = withSpecModel(fixture, {
      ...model,
      specs: { ...model.specs, 'CS150-A1': (model.specs['CS150-A1'] ?? []).map((spec) => ({ ...spec, status: 'approved' as const })) },
    });
    const checked = check(approved);
    expect(codes(checked)).not.toContain('PSC_SPEC_NOT_APPROVED');
    expect(codes(checked)).toContain('PSC_DATA_UNVERIFIED');
  });

  it('a fully verified spec passes with only the draft warning', () => {
    const verified = importedDoc({
      ...smallSpec(),
      components: [{ id: 'P', type: 'pipe', fromNps: 4, toNps: 4, schedule: '40', ends: 'BE', catalogRef: 'asme-b36.10m' }],
      sizeRange: { fromNps: 4, toNps: 4 },
      branchTable: { cells: { '4': { '4': 'T' } } },
    });
    const checked = data<Checked>(verified, 'check_pipe_spec', { specId: 'SMALL' });
    expect(codes(checked)).not.toContain('PSC_DATA_UNVERIFIED');
    expect(checked.status).toBe('warn');
  });
});

describe('check_pipe_spec dimensional standards (VC-PSC-14)', () => {
  it('EN 10220 pipe with ASME B16.9 fittings: PSC_DIM_STANDARD_MIXED on E at DN65 (76.1 vs 73.0), fail first', () => {
    const checked = data<Checked>(importedDoc(mixSpec()), 'check_pipe_spec', { specId: 'MIX-1' });
    expect(checked.status).toBe('fail');
    const mixed = checked.issues.filter((issue) => issue.code === 'PSC_DIM_STANDARD_MIXED');
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({ ids: ['E'], status: 'fail', paths: ['components.1'] });
    expect(mixed[0]?.message).toContain('DN 65: pipe 76.1 vs fitting 73');
    near(mixed[0]?.values['maxDeltaMm'], 3.1, 0.01);
    expect(checked.issues[0]?.code).toBe('PSC_DIM_STANDARD_MIXED');
  });

  it('the CS150-A1 spec (ASME pipe, ASME fittings) has no mixed-standard finding', () => {
    expect(codes(check()).filter((code) => code.startsWith('PSC_DIM_STANDARD'))).toEqual([]);
  });

  it('differences of 0.1 to 1.0 mm are only a rounding warning (EN pipe DN20 26.9 vs ASME NPS 3/4 26.7)', () => {
    const rounding = importedDoc({
      ...mixSpec(),
      id: 'MIX-2',
      sizeRange: { fromDn: 20, toDn: 20 },
      components: [
        { id: 'P', type: 'pipe', fromDn: 20, toDn: 20, standard: 'EN 10220', wallMm: 2.6, catalogRef: 'en-10220' },
        { id: 'E', type: 'elbow90', radius: 'LR', fromDn: 20, toDn: 20, catalogRef: 'asme-b16.9' },
      ],
    });
    const checked = data<Checked>(rounding, 'check_pipe_spec', { specId: 'MIX-2' });
    expect(checked.issues.find((issue) => issue.code === 'PSC_DIM_STANDARD_ROUNDING')).toMatchObject({ status: 'warn', ids: ['E'] });
    expect(codes(checked)).not.toContain('PSC_DIM_STANDARD_MIXED');
  });
});

describe('check_pipe_spec structure', () => {
  it('reports coverage gaps by type with the sizes, as warnings', () => {
    const gaps = check().issues.filter((issue) => issue.code === 'PSC_COVERAGE_GAP');
    expect(gaps.map((issue) => issue.ids[0])).toEqual(expect.arrayContaining(['tee', 'reducerConcentric', 'flange']));
    expect(gaps.find((issue) => issue.ids[0] === 'tee')?.message).toContain('1/2, 3/4, 1, 1-1/4, 1-1/2');
    const bare = importedDoc({ ...smallSpec(), components: [], branchTable: undefined });
    const empty = data<Checked>(bare, 'check_pipe_spec', { specId: 'SMALL' });
    expect(empty.issues.filter((issue) => issue.code === 'PSC_COVERAGE_GAP').map((issue) => issue.ids[0])).toEqual([
      'pipe',
      'elbow90',
      'tee',
      'reducerConcentric',
    ]);
  });

  it('equal-priority overlapping components of one type fail PSC_AMBIGUOUS_COMPONENT; different filters or priorities do not', () => {
    const spec = smallSpec();
    const pipes = spec['components'] as Json[];
    const dup = { id: 'P2', type: 'pipe', fromNps: 4, toNps: 6, schedule: '80', ends: 'BE', catalogRef: 'asme-b36.10m' };
    const overlapping = importedDoc({ ...spec, components: [...pipes, dup] });
    const checked = data<Checked>(overlapping, 'check_pipe_spec', { specId: 'SMALL' });
    expect(checked.status).toBe('fail');
    expect(checked.issues[0]).toMatchObject({ code: 'PSC_AMBIGUOUS_COMPONENT', ids: ['P', 'P2'], paths: ['components.0', 'components.2'] });
    for (const fix of [{ priority: 5 }, { ends: 'PE' }, { fromNps: 8, toNps: 8 }]) {
      const fixed = importedDoc({ ...spec, sizeRange: { fromNps: 2, toNps: 8 }, components: [...pipes, { ...dup, ...fix }] });
      expect(codes(data<Checked>(fixed, 'check_pipe_spec', { specId: 'SMALL' }))).not.toContain('PSC_AMBIGUOUS_COMPONENT');
    }
    const branchSplit = importedDoc({
      ...spec,
      components: [
        ...pipes,
        { id: 'W1', type: 'weldolet', fromNps: 2, toNps: 6, branchFromNps: 1, branchToNps: 2, catalogRef: 'mss-sp-97' },
        { id: 'W2', type: 'weldolet', fromNps: 2, toNps: 6, branchFromNps: 3, branchToNps: 4, catalogRef: 'mss-sp-97' },
      ],
    });
    expect(codes(data<Checked>(branchSplit, 'check_pipe_spec', { specId: 'SMALL' }))).not.toContain('PSC_AMBIGUOUS_COMPONENT');
  });

  it('references: an unknown catalogue fails PSC_CATALOG_UNKNOWN; a row missing from a known family warns PSC_CATALOG_ROW_MISSING', () => {
    const ghost = importedDoc({ ...smallSpec(), catalogs: ['llull-open-piping', 'ghost@2'] });
    const checked = data<Checked>(ghost, 'check_pipe_spec', { specId: 'SMALL' });
    expect(checked.issues[0]).toMatchObject({ code: 'PSC_CATALOG_UNKNOWN', status: 'fail', ids: ['ghost@2'] });
    expect(check().issues.find((issue) => issue.code === 'PSC_CATALOG_ROW_MISSING' && issue.ids[0] === 'F-WN')).toMatchObject({
      status: 'warn',
    });
  });

  it('branch table: empty cells with branch <= header warn; unresolvable cells warn with the resolution code', () => {
    const spec = smallSpec();
    const holes = importedDoc({ ...spec, branchTable: { cells: { '4': { '2': 'W' }, '6': { '2': 'T', '4': 'RT', '6': 'T' } } } });
    const checked = data<Checked>(holes, 'check_pipe_spec', { specId: 'SMALL' });
    const empty = checked.issues.find((issue) => issue.code === 'PSC_BRANCH_UNDEFINED');
    expect(empty?.ids).toEqual(['4x4']);
    expect(checked.issues.find((issue) => issue.code === 'PSC_NO_COMPONENT' && issue.rule === 'branch')?.ids).toEqual(['4x2']);
    expect(codes(check())).not.toContain('PSC_BRANCH_UNDEFINED');
    expect(codes(data<Checked>(importedDoc({ ...spec, branchTable: undefined }), 'check_pipe_spec', { specId: 'SMALL' }))).toContain(
      'PSC_BRANCH_UNDEFINED',
    );
  });

  it('joints: different classes or facings in one joint and weld-end mismatches warn PSC_END_INCOMPATIBLE', () => {
    const spec = smallSpec();
    const joined = importedDoc({
      ...spec,
      components: [
        ...(spec['components'] as Json[]),
        { id: 'F', type: 'flangeWeldNeck', fromNps: 2, toNps: 6, class: 150, facing: 'RF', catalogRef: 'asme-b16.5' },
        { id: 'G', type: 'gasketSpiralWound', fromNps: 2, toNps: 6, class: 300, catalogRef: 'asme-b16.20' },
        { id: 'V', type: 'valveGate', fromNps: 2, toNps: 6, ends: 'FL', facing: 'FF', catalogRef: 'asme-b16.10' },
        { id: 'S', type: 'elbow90', fromNps: 2, toNps: 6, radius: 'SR', ends: 'SW', catalogRef: 'asme-b16.9' },
        { id: 'X', type: 'weldolet', fromNps: 2, toNps: 6, branchFromNps: 1, branchToNps: 2, ends: 'BW', catalogRef: 'mss-sp-97' },
      ],
    });
    const end = data<Checked>(joined, 'check_pipe_spec', { specId: 'SMALL' }).issues.filter(
      (issue) => issue.code === 'PSC_END_INCOMPATIBLE',
    );
    const texts = end.map((issue) => issue.message).join(' | ');
    expect(texts).toContain('class 150 vs 300');
    expect(texts).toContain('facing RF vs FF');
    expect(texts).toContain('S has SW ends but pipe P');
    expect(end.every((issue) => issue.status === 'warn')).toBe(true);
    const adapted = importedDoc({
      ...spec,
      components: [
        ...(spec['components'] as Json[]),
        { id: 'S', type: 'elbow90', fromNps: 2, toNps: 6, radius: 'SR', ends: 'SW', catalogRef: 'asme-b16.9' },
        { id: 'SW', type: 'swage', fromNps: 2, toNps: 6, catalogRef: 'x' },
      ],
    });
    expect(codes(data<Checked>(adapted, 'check_pipe_spec', { specId: 'SMALL' }))).not.toContain('PSC_END_INCOMPATIBLE');
  });
});

describe('check_pipe_spec scope document (§5.6 pass 9)', () => {
  const legacy = withPipe(fixture, 'pipe-legacy', 76.1);
  const bound = (revision: number, odMm: number, diameter: number): CadDocument =>
    withPipe(legacy, 'pipe-spec', diameter, {
      specId: 'CS150-A1',
      revision,
      nps: '2-1/2',
      schedule: '40',
      odMm,
      wallMm: 5.16,
      dimensionalStandard: 'ASME',
      verified: true,
    });

  it('a legacy pipe without a spec warns PSC_PIPE_NO_SPEC; a pipe matching its spec row is clean', () => {
    const checked = check(bound(1, 73, 73), { scope: 'document' });
    expect(checked.issues.find((issue) => issue.code === 'PSC_PIPE_NO_SPEC')).toMatchObject({ ids: ['pipe-legacy'], status: 'warn' });
    expect(codes(checked)).not.toContain('PSC_PIPE_SPEC_MISMATCH');
    expect(checked.rulesRun).toContain('document');
  });

  it('a pipe whose OD differs from its spec row fails PSC_PIPE_SPEC_MISMATCH', () => {
    const checked = check(bound(1, 73, 76.1), { scope: 'document' });
    expect(checked.issues[0]).toMatchObject({ code: 'PSC_PIPE_SPEC_MISMATCH', status: 'fail', ids: ['pipe-spec'] });
    expect(codes(check(bound(1, 76.1, 76.1), { scope: 'document' }))).toContain('PSC_PIPE_SPEC_MISMATCH');
  });

  it('a pipe on an older revision than the latest approved warns PSC_SPEC_REVISION_STALE; an unknown revision fails PSC_SPEC_UNKNOWN', () => {
    const model = getSpecModel(fixture);
    const first = model.specs['CS150-A1']?.[0];
    if (first === undefined) throw new Error('fixture spec missing');
    const revised = withSpecModel(bound(1, 73, 73), {
      ...model,
      specs: {
        ...model.specs,
        'CS150-A1': [
          { ...first, status: 'superseded' },
          { ...first, revision: 2, status: 'approved' },
        ],
      },
    });
    expect(codes(check(revised, { scope: 'document' }))).toContain('PSC_SPEC_REVISION_STALE');
    expect(codes(check(revised, { scope: 'document', revision: 2 }))).toContain('PSC_SPEC_REVISION_STALE');
    expect(codes(check(bound(9, 73, 73), { scope: 'document' }))).toContain('PSC_SPEC_UNKNOWN');
  });

  it('without specId the document scope checks every spec; scope spec needs one', () => {
    const merged = execute(importedDoc(mixSpec()), 'import_pipe_spec', { spec: smallSpec() }).document;
    const checked = data<Checked>(merged, 'check_pipe_spec', { scope: 'document' });
    expect(checked.specs.map((spec) => spec.specId)).toEqual(['MIX-1', 'SMALL']);
    expect(checked.status).toBe('fail');
    expectRefusal(merged, 'check_pipe_spec', {}, 'PSC_SPEC_UNKNOWN', 'specId');
  });
});

describe('check_pipe_spec refusals and purity', () => {
  it('refuses an unknown spec or revision', () => {
    expectRefusal(fixture, 'check_pipe_spec', { specId: 'NOPE' }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(fixture, 'check_pipe_spec', { specId: 'CS150-A1', revision: 4 }, 'PSC_SPEC_UNKNOWN', 'revision');
    expectRefusal(createEmptyDocument(), 'check_pipe_spec', { specId: 'CS150-A1' }, 'PSC_SPEC_UNKNOWN');
  });

  it('is pure and read-only', () => {
    expectPure(fixture, () =>
      execute(fixture, 'check_pipe_spec', { specId: 'CS150-A1', scope: 'document', design: { pressureBar: 19, temperatureC: 45 } }),
    );
    const result = execute(fixture, 'check_pipe_spec', { specId: 'CS150-A1' });
    expect(result.document).toBe(fixture);
    expect(result.affected).toEqual([]);
  });
});
