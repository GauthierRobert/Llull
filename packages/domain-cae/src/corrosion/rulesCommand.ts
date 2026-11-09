/** list_compatibility_rules (PHY-13 AF-30, AF-35): the rule tables the checks use, each row with its source, grade and status. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseCor } from './codes';
import { ANODIC_GROUPS, ANODIC_LIMITS, GALVANIC_889D_MATRIX, REMEDIES, RULES } from './tables';

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant data = { rules, anodicGroups, anodicLimits, remedies, galvanic889dCells }; with ruleId only that rule (and its tables)
 * @failure unknown ruleId -> COR_PARAMS_INVALID (document unchanged)
 */
export const listCompatibilityRules = defineCommand({
  name: 'list_compatibility_rules',
  annotations: { readOnly: true, idempotent: true },
  description:
    'List the corrosion rule tables the checks use, each row with its source, grade (A/B/C) and status: rules COR-R-01..07 (MIL-STD-889D matrix: not shipped, 0 cells; anodic-index screening; small anode; ' +
    'CFRP on aluminium; remedies), the anodic groups with their index in volts (graphite has none), the environment limits and the remedy vocabulary. Use it to pick galvanicGroup ids for set_galvanic_group ' +
    'and to cite sources. ruleId filters to one rule. Read-only.',
  params: z.object({ ruleId: z.string().optional().describe('One rule id, e.g. "COR-R-02". Omit for all.') }),
  run: (doc, { ruleId }): CommandResult => {
    const rules = ruleId === undefined ? RULES : RULES.filter((rule) => rule.id === ruleId);
    if (rules.length === 0)
      return refuseCor(
        doc,
        'list_compatibility_rules',
        'COR_PARAMS_INVALID',
        `no rule '${ruleId}' (known: ${RULES.map((rule) => rule.id).join(', ')})`,
        [],
        ['ruleId'],
      );
    return report(
      doc,
      `list_compatibility_rules: ${rules.length} rule(s), ${ANODIC_GROUPS.length} anodic groups, ${ANODIC_LIMITS.length} environment limits, ${Object.keys(GALVANIC_889D_MATRIX).length} MIL-STD-889D cells (matrix not shipped); all values grade B.`,
      {
        rules,
        anodicGroups: ANODIC_GROUPS,
        anodicLimits: ANODIC_LIMITS,
        remedies: REMEDIES,
        galvanic889dCells: Object.keys(GALVANIC_889D_MATRIX).length,
      },
    );
  },
});
