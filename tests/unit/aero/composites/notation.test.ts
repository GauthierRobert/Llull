import { describe, expect, it } from 'vitest';
import { normalizeAngle, parseNotation, printNotation } from '@aero/composites/notation';
import { DEFAULT_RULES, checkStack } from '@aero/composites/rules';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { pack, panelPart } from './fixtures';

interface RuleCase {
  notation: string;
  angles_bottom_to_top: number[];
  rules: {
    plies: number;
    R1_symmetric: boolean;
    R2_balanced: boolean;
    R3_ten_percent: boolean;
    R4_max_consecutive: number;
    R4_ok: boolean;
    R5_outer_pm45: boolean;
  };
}

const cases = pack<{ cases: RuleCase[] }>('layup_rules_reference.json').cases;
const codesOf = (angles: readonly number[], config = DEFAULT_RULES): string[] => checkStack(angles, config).map((finding) => finding.code);

describe('stacking notation (VC-CMP-08)', () => {
  it.each(cases)('$notation expands to the reference angles and rule verdicts', ({ notation, angles_bottom_to_top, rules }) => {
    const parsed = parseNotation(notation);
    expect(parsed.ok).toBe(true);
    const angles = parsed.ok ? parsed.angles : [];
    expect(angles).toEqual(angles_bottom_to_top.map(normalizeAngle));
    const codes = codesOf(angles);
    expect(codes.includes('CMP_RULE_R1_SYMMETRY')).toBe(!rules.R1_symmetric);
    expect(codes.includes('CMP_RULE_R2_BALANCE')).toBe(!rules.R2_balanced);
    expect(codes.includes('CMP_RULE_R3_MIN_FRACTION')).toBe(!rules.R3_ten_percent);
    expect(codes.includes('CMP_RULE_R4_MAX_CONSECUTIVE')).toBe(!rules.R4_ok);
    expect(codes.includes('CMP_RULE_R5_OUTER_PM45')).toBe(!rules.R5_outer_pm45);
    expect(angles).toHaveLength(rules.plies);
  });

  it('expands the documented forms', () => {
    const angles = (text: string): readonly number[] => {
      const parsed = parseNotation(text);
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.angles;
    };
    expect(angles('[0/+-45/90]s')).toEqual([0, 45, -45, 90, 90, -45, 45, 0]);
    expect(angles('[0/±45/90]s')).toEqual(angles('[0/+-45/90]s'));
    expect(angles('[0/90]_2s')).toEqual([0, 90, 0, 90, 90, 0, 90, 0]);
    expect(angles('[0/90]2s')).toEqual(angles('[0/90]_2s'));
    expect(angles('[45/-45/0_2/90~]s')).toEqual([45, -45, 0, 0, 90, 0, 0, -45, 45]);
    expect(angles('[0/90]T')).toEqual([0, 90]);
    expect(angles('[(0/90)_2/45]')).toEqual([0, 90, 0, 90, 45]);
    expect(angles(' [ 0 / -45 ] ')).toEqual([0, -45]);
    expect(angles('[135/-90/180]T')).toEqual([-45, 90, 0]);
    expect(Object.is(angles('[-0]T')[0], -0)).toBe(false);
  });

  it('names the offending token of a malformed string', () => {
    const letter = parseNotation('[45/-45/0/9O]s');
    expect(letter).toMatchObject({ ok: false, token: '9O', index: 3 });
    expect(parseNotation('0/90')).toMatchObject({ ok: false });
    expect(parseNotation('[0/(90]s')).toMatchObject({ ok: false, message: expect.stringContaining('parenthes') });
    expect(parseNotation('[]s')).toMatchObject({ ok: false });
    expect(parseNotation('[0/90]_0s')).toMatchObject({ ok: false });
    expect(parseNotation('[0_3000]T')).toMatchObject({ ok: false });
    expect(parseNotation('[((((((((((0)))))))))]T')).toMatchObject({ ok: false });
  });

  it('prints the shortest canonical string and round-trips', () => {
    expect(printNotation([0, 45, -45, 90, 90, -45, 45, 0])).toBe('[0/+-45/90]s');
    expect(printNotation([45, -45, 0, 0, 90, 0, 0, -45, 45])).toBe('[+-45/0_2/90~]s');
    expect(printNotation([0, 90])).toBe('[0/90]T');
    expect(printNotation([0, 90, 0])).toBe('[0/90~]s');
    expect(printNotation([45, -45, 45, -45, 0, 0, -45, 45, -45, 45])).toBe('[+-45_2/0]s');
    for (const { angles_bottom_to_top } of cases) {
      const text = printNotation(angles_bottom_to_top.map(normalizeAngle));
      const parsed = parseNotation(text);
      expect(parsed.ok && parsed.angles).toEqual(angles_bottom_to_top.map(normalizeAngle));
    }
  });
});

describe('rule configuration (VC-CMP-09, VC-CMP-25)', () => {
  const half = parseNotation('[+-45/0_4/90_2]s');

  it('flips R4 with maxConsecutive 3 and R3 with minFraction 0.3', () => {
    const angles = half.ok ? half.angles : [];
    expect(codesOf(angles)).toEqual([]);
    expect(codesOf(angles, { ...DEFAULT_RULES, maxConsecutive: 3 })).toContain('CMP_RULE_R4_MAX_CONSECUTIVE');
    expect(codesOf(angles, { ...DEFAULT_RULES, minFraction: 0.3 })).toContain('CMP_RULE_R3_MIN_FRACTION');
  });

  it('flags the adjacent-ply angle changes of the disorientation rule', () => {
    const config = { ...DEFAULT_RULES, maxAngleChange: 45 };
    const bad = checkStack([0, 90, 45, -45, -45, 45, 90, 0], config).filter((finding) => finding.code === 'CMP_RULE_DISORIENTATION');
    expect(bad.map((finding) => finding.plies)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    expect(checkStack([45, 0, -45, 90, 90, -45, 0, 45], config).filter((finding) => finding.code === 'CMP_RULE_DISORIENTATION')).toEqual(
      [],
    );
  });

  it('skips a disabled rule', () => {
    const disabled = {
      ...DEFAULT_RULES,
      disabled: [
        { rule: 'R4', justification: 'test' },
        { rule: 'DISORIENTATION', justification: 'test' },
      ],
      maxAngleChange: 10,
    };
    expect(codesOf([45, 0, 0, 0, 0, 0, 0, 45], disabled)).toEqual(['CMP_RULE_R2_BALANCE', 'CMP_RULE_R3_MIN_FRACTION']);
    expect(checkStack([], DEFAULT_RULES)).toEqual([]);
  });

  it('check_laminate_rules reports findings, named thresholds and refuses an unknown part', () => {
    const { doc, part } = panelPart();
    let next = apply(doc, 'define_zone', {
      part,
      name: 'bad',
      boundary: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      laminate: '[45/0_5/-45/90]s',
      priority: 0,
    });
    next = apply(next, 'define_zone', {
      part,
      name: 'good',
      boundary: [
        [200, 200],
        [300, 200],
        [300, 300],
        [200, 300],
      ],
      laminate: '[45/-45/0/90]s',
      priority: 1,
    });
    const result = data<{
      status: string;
      findings: { code: string; zoneName: string; plies: number[] }[];
      thresholds: Record<string, { defaulted: boolean; value: unknown }>;
      checked: string[];
    }>(next, 'check_laminate_rules', { part });
    expect(result.status).toBe('fail');
    expect(result.checked).toEqual(['bad', 'good']);
    expect(result.findings.map((finding) => finding.code)).toEqual(['CMP_RULE_R4_MAX_CONSECUTIVE', 'CMP_RULE_R4_MAX_CONSECUTIVE']);
    expect(result.findings[0]).toMatchObject({ zoneName: 'bad', plies: [1, 2, 3, 4, 5] });
    expect(result.thresholds['maxConsecutive']).toMatchObject({ value: 4, defaulted: true });
    const relaxed = data<{ status: string; thresholds: Record<string, { defaulted: boolean; source: string }> }>(
      next,
      'check_laminate_rules',
      { part, zones: ['good'], thresholds: { maxConsecutive: 6 } },
    );
    expect(relaxed.status).toBe('pass');
    expect(relaxed.thresholds['maxConsecutive']).toMatchObject({ defaulted: false, source: 'call parameter' });
    const configured = apply(next, 'set_laminate_rules', { part, maxConsecutive: 6 });
    expect(data<{ status: string }>(configured, 'check_laminate_rules', { part }).status).toBe('pass');
    expectRefusal(doc, 'check_laminate_rules', { part: 'nope' }, 'CMP_REF_MISSING');
  });
});
