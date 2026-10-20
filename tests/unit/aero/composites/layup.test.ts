import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { AS4, BASE, HOLE, PAD, panel, panelPart } from './fixtures';

interface Finding {
  code: string;
  severity: 'fail' | 'warn';
  ids: string[];
  value?: number;
  limit?: number;
  waiverStatus?: string;
}
interface Report {
  status: string;
  findings: Finding[];
  defaults: Record<string, { value: unknown; defaulted: boolean }>;
  unverified: boolean;
  reviewRequired: boolean;
  reviewReason?: string;
  thresholds: Record<string, { defaulted: boolean }>;
}

const codes = (report: Report): string[] => report.findings.map((finding) => finding.code);
const { doc, part } = panel();
const check = (document: CadDocument, params: object = {}): Report => data<Report>(document, 'check_layup', { part, ...params });

describe('check_layup (VC-CMP-35..37)', () => {
  it('passes a verified, rule-conforming panel and names its defaults on release', () => {
    const design = check(doc);
    expect(design.status).toBe('pass');
    expect(design.findings).toEqual([]);
    expect(design.reviewRequired).toBe(false);
    const release = check(doc, { purpose: 'release' });
    expect(release.status).toBe('warn');
    expect(codes(release)).toEqual(['CMP_DEFAULT_USED']);
    expect(release.reviewRequired).toBe(true);
    expect(release.reviewReason).toContain('not approved');
    expect(release.defaults['maxConsecutive']).toMatchObject({ value: 4, defaulted: true });
    expect(release.thresholds['minFraction']).toMatchObject({ defaulted: true });
  });

  it('flags mean-basis material as unverified and cannot be suppressed by thresholds', () => {
    const mean = apply(doc, 'edit_ply', { part, ply: 'S3', material: 'AS4_3501_6' });
    const report = check(mean, { thresholds: { minFraction: 0, maxConsecutive: 99 } });
    expect(report.unverified).toBe(true);
    expect(codes(report)).toContain('CMP_MATERIAL_UNVERIFIED');
    expect(report.findings.find((finding) => finding.code === 'CMP_MATERIAL_UNVERIFIED')).toMatchObject({
      severity: 'warn',
      ids: ['AS4_3501_6'],
    });
    expect(report.status).toBe('warn');
    expect(AS4.basis).toBe('mean');
  });

  it('fails a strength ratio below 1 and keeps it failed behind a pending waiver (VC-CMP-37)', () => {
    const loads = [{ name: 'ultimate', Nx: 400 }];
    const failed = check(doc, { loads });
    const fpf = failed.findings.find((finding) => finding.code === 'CMP_FPF_RATIO_BELOW_ONE');
    expect(failed.status).toBe('fail');
    expect(fpf).toMatchObject({ severity: 'fail', limit: 1 });
    expect(fpf?.value).toBeCloseTo(0.690298, 4);
    expect(failed.reviewRequired).toBe(true);
    const requested = ok(doc, 'request_layup_waiver', {
      part,
      code: 'CMP_FPF_RATIO_BELOW_ONE',
      ids: fpf?.ids,
      reason: 'tested to 1.5 times limit',
      loads,
    });
    const waiver = Object.values(requested.document.composites?.waivers ?? {})[0];
    expect(waiver).toMatchObject({ code: 'CMP_FPF_RATIO_BELOW_ONE', requestedBy: 'agent', reason: 'tested to 1.5 times limit' });
    expect(waiver?.approvalRef).toBeUndefined();
    const after = check(requested.document, { loads });
    expect(after.status).toBe('fail');
    expect(after.findings.find((finding) => finding.code === 'CMP_FPF_RATIO_BELOW_ONE')?.waiverStatus).toBe('pending');
    expect(codes(after)).toContain('CMP_WAIVER_PENDING');
  });

  it('downgrades a failure to a warning once the waiver carries an approval reference', () => {
    const loads = [{ Nx: 400 }];
    const fpf = check(doc, { loads }).findings.find((finding) => finding.code === 'CMP_FPF_RATIO_BELOW_ONE');
    const requested = apply(doc, 'request_layup_waiver', { part, code: 'CMP_FPF_RATIO_BELOW_ONE', ids: fpf?.ids, reason: 'r', loads });
    const [id, waiver] = Object.entries(requested.composites?.waivers ?? {})[0] ?? [];
    const approved = {
      ...requested,
      composites: { ...requested.composites, waivers: { [id as string]: { ...waiver, approvalRef: 'APR-1' } } },
    } as CadDocument;
    const report = check(approved, { loads });
    expect(report.status).toBe('warn');
    expect(report.findings.find((finding) => finding.code === 'CMP_FPF_RATIO_BELOW_ONE')).toMatchObject({
      severity: 'warn',
      waiverStatus: 'approved',
    });
  });

  it('refuses a waiver without a matching failing finding or with a bad part', () => {
    expectRefusal(doc, 'request_layup_waiver', { part, code: 'CMP_FPF_RATIO_BELOW_ONE', ids: [], reason: 'x' }, 'CMP_WAIVER_NO_FINDING');
    expectRefusal(doc, 'request_layup_waiver', { part: 'nope', code: 'X', ids: [], reason: 'x' }, 'CMP_REF_MISSING');
  });

  it('reports rule violations, non-blendable zones and ramp conflicts as failures', () => {
    const { doc: bare, part: p } = panelPart();
    let bad = apply(bare, 'define_zone', { part: p, ...BASE, laminate: '[0/90]s' });
    bad = apply(bad, 'define_zone', { part: p, ...PAD, laminate: '[45/-45/0]s' });
    bad = apply(bad, 'add_ply', { part: p, name: 'one', material: 'T300_5208', orientation: 0, boundary: { kind: 'whole_face' } });
    const report = data<Report>(bad, 'check_layup', { part: p });
    expect(codes(report)).toEqual(expect.arrayContaining(['CMP_RULE_R5_OUTER_PM45', 'CMP_ZONES_NOT_BLENDABLE']));
    expect(report.status).toBe('fail');
    let tight = apply(bare, 'define_zone', { part: p, ...BASE });
    tight = apply(tight, 'define_zone', { part: p, ...PAD });
    tight = apply(tight, 'define_zone', {
      part: p,
      ...HOLE,
      boundary: [
        [205, 105],
        [395, 105],
        [395, 295],
        [205, 295],
      ],
    });
    tight = apply(tight, 'add_ply', { part: p, name: 'one', material: 'T300_5208', orientation: 45, boundary: { kind: 'whole_face' } });
    const ramp = data<Report>(tight, 'check_layup', { part: p });
    expect(ramp.findings.find((finding) => finding.code === 'CMP_RAMP_CONFLICT')).toMatchObject({ severity: 'fail', limit: 20 });
    expect(ramp.findings.find((finding) => finding.code === 'CMP_RAMP_CONFLICT')?.value).toBeCloseTo(5, 9);
  });

  it('warns when a material has no strengths for the requested load cases, and rules still apply with disabled ones on release', () => {
    const weak = apply(doc, 'create_lamina_material', {
      name: 'weak',
      form: 'ud_tape',
      E1: 100000,
      E2: 8000,
      G12: 4000,
      nu12: 0.3,
      plyThickness: 0.125,
      source: 'test',
    });
    const swapped = apply(weak, 'edit_ply', { part, ply: 'S1', material: 'weak' });
    const report = check(swapped, { loads: [{ Nx: 1 }] });
    expect(codes(report)).toContain('CMP_MATERIAL_ALLOWABLE_MISSING');
    const relaxed = apply(doc, 'set_laminate_rules', { part, outerPlusMinus45: true, disable: [{ rule: 'R5', justification: 'test' }] });
    const edited = apply(relaxed, 'edit_ply', { part, ply: 'S1', orientation: 0 });
    expect(codes(check(edited))).not.toContain('CMP_RULE_R5_OUTER_PM45');
    expect(codes(check(edited, { purpose: 'release' }))).toContain('CMP_RULE_R5_OUTER_PM45');
  });

  it('refuses an unknown part and is pure', () => {
    expectRefusal(doc, 'check_layup', { part: 'nope' }, 'CMP_REF_MISSING');
    expectPure(doc, () => execute(doc, 'check_layup', { part, loads: [{ Nx: 400 }] }));
    expectPure(doc, () => execute(doc, 'request_layup_waiver', { part, code: 'X', ids: [], reason: 'x' }));
  });
});
