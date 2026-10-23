import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { refuse } from '../codes';
import { ALL_RULES, RULESET_NAMES, RULE_TABLE_VERSION, ruleFlag } from '../rules/ruleTable';

/**
 * @affects none: read-only query, answers in `data` { ruleTableVersion, rules, unloaded }
 * @invariant rows are the built-in table verbatim (mm / N / deg, imperial original kept); grade C rows are listed with loaded: false
 * @failure ruleset not loaded -> STA_RULESET_UNKNOWN
 */
export const listAccessRules = defineCommand({
  name: 'list_access_rules',
  description:
    'List the access-structure rules check_access evaluates: id, ruleset, clause, quantity, limits in mm / N / degrees (with the imperial original), ' +
    'grade and source. Grade A rows gate (fail), grade B rows only warn with STA_RULE_UNVERIFIED, grade C rows are listed with loaded: false and never evaluated. ' +
    'Rows with an open caveat carry a `flag` (the OSHA 2036 ladder retrofit date is under a proposed repeal, status unknown). Filter by ruleset and/or grade; ' +
    'without a grade filter only the loaded rows (A and B) are returned. Read-only.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    ruleset: z.string().optional().describe('Ruleset to list: "iso_14122" or "osha_1910". Default: both.'),
    grade: z
      .enum(['A', 'B', 'C'])
      .optional()
      .describe('Only rows of this grade. Default: A and B (the loaded rows); "C" lists the rows that are not loaded.'),
  }),
  run: (doc, { ruleset, grade }): CommandResult => {
    if (ruleset !== undefined && !(RULESET_NAMES as readonly string[]).includes(ruleset)) {
      return refuse(
        doc,
        'list_access_rules',
        'STA_RULESET_UNKNOWN',
        `ruleset "${ruleset}" is not loaded (${RULESET_NAMES.join(', ')})`,
        [],
        ['ruleset'],
      );
    }
    const inRuleset = ALL_RULES.filter((rule) => ruleset === undefined || rule.ruleset === ruleset);
    const rows = inRuleset
      .filter((rule) => (grade === undefined ? rule.grade !== 'C' : rule.grade === grade))
      .map((rule) => {
        const flag = ruleFlag(rule.id);
        return { ...rule, loaded: rule.grade !== 'C', ...(flag === undefined ? {} : { flag }) };
      });
    const unloaded = inRuleset.filter((rule) => rule.grade === 'C').map((rule) => rule.id);
    return report(
      doc,
      `list_access_rules: ${rows.length} rule(s)${ruleset === undefined ? '' : ` of ${ruleset}`}${grade === undefined ? '' : ` grade ${grade}`} ` +
        `(rule table ${RULE_TABLE_VERSION}); ${unloaded.length} grade C row(s) are not loaded.`,
      { ruleTableVersion: RULE_TABLE_VERSION, rules: rows, unloaded },
    );
  },
});
