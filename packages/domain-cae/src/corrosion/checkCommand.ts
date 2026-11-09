/** check_material_compatibility (PHY-13 FR-COR-12, AF-20): galvanic compatibility of every contacting pair, composed from find_contacts and the stack contacts. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { ContactPair } from '@core/geometry/contacts';
import { refuseCor } from './codes';
import { type CompatibilityItem, type ItemStatus, galvanicItem } from './items';
import { corrosionOf } from './model';
import { rootOf } from './resolve';
import { reportCsv } from './reportCsv';
import { stackContacts } from './stacks';

const COMMAND = 'check_material_compatibility';
const RANK: Readonly<Record<ItemStatus, number>> = { pass: 0, pass_isolated: 1, warn: 2, unknown: 3, fail: 4 };

interface ContactsData {
  readonly pairs: readonly ContactPair[];
  readonly tolerance: Record<string, unknown>;
}

/** Overall status: the worst of the items that no human acceptance covers. */
function overall(items: readonly CompatibilityItem[]): ItemStatus {
  return items
    .filter((item) => item.acceptance?.decision !== 'accepted')
    .reduce<ItemStatus>((worst, item) => (RANK[item.status] > RANK[worst] ? item.status : worst), 'pass');
}

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant data = { status, scheme, environment, items, counts, tolerance, contacts, notes }; one galvanic item per contacting pair (geometric contacts of find_contacts merged with
 *   fastener-stack pairs by instance); every item reviewRequired and unverified (grade B rules); an unresolved material, group, index or table is `unknown`, never pass; SCC / HE rules are not evaluated (M5)
 * @failure no environment -> COR_ENVIRONMENT_UNSET; a find_contacts refusal (unknown id, bad tolerance) is returned as is (document unchanged)
 */
export const checkMaterialCompatibility = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Check the galvanic compatibility of every pair of parts in contact (find_contacts, plus the pairs that touch by construction in placed fastener stacks) against the document ' +
    'service environment (set_service_environment: REQUIRED) and the galvanic group of each part (set_galvanic_group per material; a plated part uses its plating group, assign_surface_system). ' +
    'Scheme anodic_index: anode = larger anodic index, compatible when the difference is <= the environment limit (harsh 0.15 V, normal 0.25 V, controlled 0.50 V); this is a screening rule of thumb, NOT MIL-STD-889, ' +
    'so every item carries COR_SCREENING_RULE_ONLY. A smaller anode on a larger cathode warns COR_SMALL_ANODE (area ratio from box surface areas). Carbon fibre (group graphite) on aluminium fails COR_CFRP_ALUMINIUM. ' +
    'A pair covered by declare_isolation reports pass_isolated. A part with no material, group or index is `unknown` (COR_MATERIAL_MISSING, COR_GROUP_MISSING, COR_GROUP_VALUE_MISSING), never pass. ' +
    'Scheme mil_std_889d reports COR_889_TABLE_MISSING (the matrix is not shipped). Every item has reviewRequired true: a human decides; stress-corrosion and hydrogen-embrittlement rules are not evaluated. ' +
    'Returns data { status: pass | warn | unknown | fail (worst unaccepted item), scheme, environment, items: [{ key, status, code, ruleId, ruleGrade, ids, inputs, warnings, remedies, unverified, reviewRequired, acceptance? }], counts, tolerance, contacts }. ' +
    'report: true adds data.text (CSV, `--save corrosion.csv`). Next: declare_isolation, accept_corrosion_item (human only).',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Only contacts among these solids (an instance id stands for its children). Omit for the whole document.'),
    tolerance: z
      .object({ value: z.number().describe('Positive, finite.'), unit: z.enum(['mm', 'cm', 'm', 'in', 'ft']).describe('Length unit.') })
      .optional()
      .describe('Largest gap still counted as a contact (find_contacts). Default 0.0025 mm.'),
    includeStacks: z.boolean().optional().describe('Merge the contacts of placed fastener stacks (default true).'),
    report: z.boolean().optional().describe('true: data.text holds the CSV report and data.fileName its name.'),
  }),
  run: (doc, { entityIds, tolerance, includeStacks, report: wantsReport }, ctx): CommandResult => {
    const model = corrosionOf(doc);
    if (model.environment === undefined)
      return refuseCor(doc, COMMAND, 'COR_ENVIRONMENT_UNSET', 'no service environment is set (there is no default)', [], ['environment']);
    const { scheme, value: environment } = model.environment;
    const found = execute(
      doc,
      'find_contacts',
      { ...(entityIds === undefined ? {} : { entityIds }), ...(tolerance === undefined ? {} : { tolerance }) },
      ctx,
    );
    if (found.error !== undefined) return { ...found, summary: `${COMMAND}: ${found.summary}` };
    const contacts = found.data as ContactsData;
    const scope = entityIds === undefined ? null : new Set(entityIds.map(rootOf));
    const pairKey = (a: string, b: string): string => [rootOf(a), rootOf(b)].sort().join('|');
    const stacks = includeStacks === false ? [] : stackContacts(doc).filter(([a, b]) => scope === null || (scope.has(a) && scope.has(b)));
    const stackKeys = new Set(stacks.map(([a, b]) => pairKey(a, b)));
    const geometricKeys = new Set(contacts.pairs.map((pair) => pairKey(pair.a, pair.b)));
    const geometric = contacts.pairs.map((pair) => ({ ...pair, stack: stackKeys.has(pairKey(pair.a, pair.b)) }));
    const fromStacks = stacks
      .filter(([a, b]) => !geometricKeys.has(pairKey(a, b)))
      .map(([a, b]) => ({
        a,
        b,
        kind: 'face' as const,
        source: 'aabb' as const,
        approximate: false,
        materials: [null, null] as const,
        stack: true,
      }));
    const items = [...geometric, ...fromStacks]
      .map((pair) => galvanicItem(doc, pair, scheme, environment, model.acceptances))
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const status = overall(items);
    const counts: Record<string, number> = { accepted: items.filter((item) => item.acceptance?.decision === 'accepted').length };
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const notes = ['stress-corrosion (SCC) and hydrogen-embrittlement (HE) rules are not evaluated: their tables are not shipped'];
    const worst = items
      .filter((item) => RANK[item.status] >= RANK.warn)
      .slice(0, 8)
      .map((item) => `${item.key} ${item.status} ${item.code}`);
    const summary =
      `${COMMAND}: ${status} - ${items.length} contacting pair(s) under ${scheme}/${environment} (${Object.entries(counts)
        .map(([name, n]) => `${name} ${n}`)
        .join(', ')}); ` +
      `every item needs human review and rests on grade B screening values${worst.length > 0 ? `; ${worst.join('; ')}` : ''}.`;
    return report(doc, summary, {
      status,
      scheme,
      environment,
      items,
      counts,
      tolerance: contacts.tolerance,
      contacts: contacts.pairs.length,
      notes,
      ...(wantsReport === true ? { text: reportCsv(items), fileName: 'corrosion.csv' } : {}),
    });
  },
});
