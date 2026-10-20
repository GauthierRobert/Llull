/** check_laminate_rules: design rules R1-R5 on the zone stacks of a part (FR-CMP-20, FR-CMP-21). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { refuseCmp } from './codes';
import { effectiveRules, ruleFindings } from './ruleReport';
import { compositesOf, findPart } from './state';

/**
 * @affects nothing (read-only)
 * @invariant findings carry stable CMP_RULE_* codes, the zone, the 0-based offending ply indices (bottom to top), value, limit and a remediation; thresholds report their source and whether they are defaults
 * @failure unknown part -> CMP_REF_MISSING
 */
export const checkLaminateRules = defineCommand({
  name: 'check_laminate_rules',
  annotations: { readOnly: true },
  description:
    'Check the laminate design rules on the stack of every zone of a composite part (or of the whole ply list when it has no zones): ' +
    'R1 symmetric (CMP_RULE_R1_SYMMETRY), R2 balanced (CMP_RULE_R2_BALANCE), R3 minimum fraction of plies in each of the 0 / +-45 / 90 ' +
    'families, default 10% (CMP_RULE_R3_MIN_FRACTION), R4 at most 4 consecutive plies of one angle (CMP_RULE_R4_MAX_CONSECUTIVE), R5 outer ' +
    'plies +-45 (CMP_RULE_R5_OUTER_PM45), plus CMP_RULE_DISORIENTATION when maxAngleChange is set. Thresholds come from set_laminate_rules ' +
    'and may be overridden per call in `thresholds` (minFraction is a fraction 0..1, maxAngleChange degrees); the result lists every ' +
    'threshold with its source and whether it is a default (common published guidelines, not CMH-17 clauses). data.status is "pass" or ' +
    '"fail"; each finding has zone, ply indices, value, limit, unit and a remediation. Read-only.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    zones: z.array(z.string().describe('Zone id or name.')).describe('Only these zones; default all.').optional(),
    thresholds: z
      .object({
        symmetric: z.boolean().describe('Require R1 symmetry.').optional(),
        balanced: z.boolean().describe('Require R2 balance.').optional(),
        minFraction: z.number().describe('R3 minimum fraction (0..1) of plies per family.').optional(),
        maxConsecutive: z.number().describe('R4 maximum consecutive plies of one angle (plies).').optional(),
        outerPlusMinus45: z.boolean().describe('Require R5 +-45 outer plies.').optional(),
        maxAngleChange: z.number().describe('Maximum angle change between adjacent plies, degrees.').optional(),
      })
      .describe('Per-call overrides of the part rules.')
      .optional(),
  }),
  run: (doc, { part: partRef, zones, thresholds }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'check_laminate_rules', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const { rules, named } = effectiveRules(part, thresholds);
    const { findings, checked } = ruleFindings(model, part, rules, zones);
    const status = findings.length === 0 ? 'pass' : 'fail';
    const codes = [...new Set(findings.map((finding) => finding.code))];
    return report(
      doc,
      `check_laminate_rules: part "${part.name}": ${status}; ${checked.length} stack(s) checked (${checked.join(', ')}), ${findings.length} finding(s)${codes.length > 0 ? `: ${codes.join(', ')}` : ''}.`,
      {
        status,
        part: part.id,
        checked,
        findings,
        thresholds: named,
        disabledRules: rules.disabled ?? [],
        provenance: {
          method: 'laminate design rules R1-R5',
          reference: 'common published guidelines (CMH-17 / industry practice), not quoted clauses',
          inputs: { part: part.id },
        },
      },
    );
  },
});
