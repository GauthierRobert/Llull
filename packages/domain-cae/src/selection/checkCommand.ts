/** check_material_selection (PHY-12 FR-SEL-17, AF-20): the selection-relevant state of the materials a document uses. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { materialsInUse } from '@core/model/materialsInUse';
import { basesOf, mixedBasesWarning } from './bases';
import { issue, REVIEW_SENTENCE, refuseSel } from './codes';
import { resolveProperty } from './properties';
import type { PropertyUse, SelIssue } from './types';

const COMMAND = 'check_material_selection';

/** Properties every selection and substitution reads; density is needed for mass, E for the stiffness indices. */
const CHECKED = [
  { property: 'density', unit: 'Mg/m^3', severity: 'warning' },
  { property: 'E', unit: 'GPa', severity: 'info' },
] as const;

type Status = 'pass' | 'warn' | 'fail';

const statusOf = (items: readonly SelIssue[]): Status =>
  items.some((entry) => entry.severity === 'error') ? 'fail' : items.some((entry) => entry.severity === 'warning') ? 'warn' : 'pass';

/**
 * @affects nothing - read-only; data { status, items[{ code, severity, ids, message, remediation }], materials[], basesUsed[], unverified, reviewRequired }
 * @invariant status fail on any error, warn on warnings only, pass otherwise; materials in ascending id order; every unverified input is reported (SEL_VALUE_UNVERIFIED,
 *   not suppressible); a material without density is SEL_PROPERTY_MISSING (warning), without E info
 * @failure an entity id that is not in the document SEL_ENTITY_NOT_FOUND (refusal, unchanged doc)
 */
export const checkMaterialSelection = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Check the materials a document uses for selection and substitution: for each material assigned to an entity (all entities, or only entityIds) the density and E must exist ' +
    '(SEL_PROPERTY_MISSING: density is a warning, E only info), typical / supplier / legacy values are reported as SEL_VALUE_UNVERIFIED (warning, not suppressible), and several bases among the ' +
    'values in use give SEL_BASIS_MIXED. Returns data { status pass | warn | fail, items: [{ code, severity, ids, message, remediation }], materials: [{ material, entityIds, inputs }], basesUsed, ' +
    'unverified, reviewRequired: true }. Run it after compare_materials / substitute_material and before telling the owner that a swap is fine. Read-only.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Entities whose materials are checked; omit for every entity of the document (and of its components).'),
  }),
  run: (doc, params): CommandResult => {
    const missingIds = (params.entityIds ?? []).filter((id) => !Object.hasOwn(doc.entities, id));
    if (missingIds.length > 0)
      return refuseSel(doc, COMMAND, 'SEL_ENTITY_NOT_FOUND', `no entity ${missingIds.map((id) => `'${id}'`).join(', ')}`, missingIds, [
        'entityIds',
      ]);
    const inUse = [...materialsInUse(doc, params.entityIds)].sort(([a], [b]) => a.localeCompare(b));
    const items: SelIssue[] = [];
    const rows: { material: string; entityIds: string[]; inputs: PropertyUse[] }[] = [];
    for (const [material, entityIds] of inUse) {
      const inputs: PropertyUse[] = [];
      if (!Object.hasOwn(doc.materials, material)) {
        items.push(issue('SEL_MATERIAL_NOT_FOUND', 'error', `entity material '${material}' is not defined in the document`, entityIds));
        continue;
      }
      for (const { property, unit, severity } of CHECKED) {
        const found = resolveProperty(doc, material, property, unit);
        if (!found.ok) {
          items.push(issue(found.code, severity, `'${material}': ${found.reason}`, [material, ...entityIds]));
          continue;
        }
        inputs.push(found.use);
      }
      const weak = inputs.filter((input) => input.unverified);
      if (weak.length > 0)
        items.push(
          issue(
            'SEL_VALUE_UNVERIFIED',
            'warning',
            `'${material}': ${weak.map((input) => `${input.property} (${input.unverifiedReasons.join(', ')})`).join('; ')}`,
            [material, ...weak.map((input) => input.propertyValueId)],
          ),
        );
      rows.push({ material, entityIds, inputs });
    }
    const bases = basesOf(rows.flatMap((row) => row.inputs));
    items.push(
      ...mixedBasesWarning(
        bases,
        rows.map((row) => row.material),
      ),
    );
    const status = statusOf(items);
    const unverified = rows.some((row) => row.inputs.some((input) => input.unverified));
    return report(
      doc,
      `${COMMAND}: ${status} (${rows.length} material(s) in use, ${items.length} item(s)${items.length > 0 ? `: ${[...new Set(items.map((entry) => entry.code))].join(', ')}` : ''}); ${REVIEW_SENTENCE}.`,
      { status, items, materials: rows, basesUsed: bases, unverified, reviewRequired: true },
    );
  },
});
