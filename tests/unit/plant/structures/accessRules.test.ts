import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { ALL_RULES, LOADED_RULES, RULE_TABLE_VERSION, breach, limitOf, ruleById, severityOf } from '@aec/plant/structures/rules/ruleTable';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface RuleRow {
  id: string;
  rules?: never;
}
interface Listing {
  ruleTableVersion: string;
  rules: Array<RuleRow & { grade: string; loaded: boolean; flag?: string; ruleset: string }>;
  unloaded: string[];
}

describe('access rule table', () => {
  it('is the pack file verbatim (38 rows, same ids, grades and limits)', () => {
    const pack = JSON.parse(readFileSync('docs/plant/06-plant-structures-access/validation/data/access_rules.json', 'utf8')) as {
      rules: unknown[];
    };
    expect(ALL_RULES).toEqual(pack.rules);
    expect(ALL_RULES).toHaveLength(38);
    expect(RULE_TABLE_VERSION).toBe('2026-10-18');
  });

  it('loads grade A and B rows only', () => {
    expect(LOADED_RULES.every((rule) => rule.grade !== 'C')).toBe(true);
    expect(LOADED_RULES.length).toBe(ALL_RULES.filter((rule) => rule.grade !== 'C').length);
    expect(() => ruleById('ISO-LAD-FLIGHT')).toThrow(/not in the loaded table/);
  });

  it('every limit row passes at its limits and breaches just outside (A fails, B warns, maxSeverity caps)', () => {
    const limited = LOADED_RULES.filter((rule) => limitOf(rule).min !== undefined || limitOf(rule).max !== undefined);
    expect(limited.length).toBeGreaterThan(25);
    for (const rule of limited) {
      const { min, max } = limitOf(rule);
      if (min !== undefined) {
        expect(breach(rule, min), rule.id).toBeNull();
        expect(breach(rule, min - 0.001), rule.id).toBe('below');
      }
      if (max !== undefined) {
        expect(breach(rule, max), rule.id).toBeNull();
        expect(breach(rule, max + 0.001), rule.id).toBe('above');
      }
      const expected = rule.grade === 'A' && rule.maxSeverity === undefined ? 'fail' : 'warn';
      expect(severityOf(rule), rule.id).toBe(expected);
    }
  });

  it('keeps the OSHA 24 ft boundary: 7315.2 mm passes, 7315.3 mm requires fall protection', () => {
    const rule = ruleById('OSHA-LAD-FALLPROT-HEIGHT');
    expect(breach(rule, 7315.2)).toBeNull();
    expect(breach(rule, 7315.3)).toBe('above');
  });

  it('caps the OSHA top rail above 45 in at warn', () => {
    const rule = ruleById('OSHA-GRD-TOP');
    expect(breach(rule, 1200)).toBe('above');
    expect(severityOf(rule)).toBe('warn');
    expect(breach(rule, 980)).toBe('below');
  });
});

describe('list_access_rules', () => {
  const doc = createEmptyDocument();

  it('lists the loaded rows with units, grade, source and the D10 flag, and the unloaded ids', () => {
    const result = data<Listing>(doc, 'list_access_rules', {});
    expect(result.ruleTableVersion).toBe('2026-10-18');
    expect(result.rules).toHaveLength(LOADED_RULES.length);
    expect(result.rules.every((rule) => rule.loaded && rule.grade !== 'C')).toBe(true);
    expect(result.unloaded).toEqual(['ISO-LAD-FLIGHT', 'ISO-GRD-POST-SPACING']);
    const flagged = result.rules.filter((rule) => rule.flag !== undefined);
    expect(flagged.map((rule) => rule.id)).toEqual(['OSHA-LAD-FALLPROT-HEIGHT']);
    expect(flagged[0]?.flag).toMatch(/proposed repeal/);
    expect(flagged[0]?.flag).toMatch(/status unknown/);
  });

  it('filters by ruleset and grade; grade C shows the rows that are not loaded', () => {
    const iso = data<Listing>(doc, 'list_access_rules', { ruleset: 'iso_14122', grade: 'A' });
    expect(iso.rules.length).toBeGreaterThan(5);
    expect(iso.rules.every((rule) => rule.ruleset === 'iso_14122' && rule.grade === 'A')).toBe(true);
    const unloaded = data<Listing>(doc, 'list_access_rules', { grade: 'C' });
    expect(unloaded.rules.map((rule) => rule.loaded)).toEqual([false, false]);
  });

  it('leaves the document untouched (is pure)', () => {
    const before = JSON.stringify(doc);
    const result = ok(doc, 'list_access_rules', { ruleset: 'osha_1910' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('refuses an unknown ruleset (STA_RULESET_UNKNOWN)', () => {
    expectRefusal(doc, 'list_access_rules', { ruleset: 'din_nope' }, 'STA_RULESET_UNKNOWN', 'ruleset');
  });
});
