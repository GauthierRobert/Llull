/** check_surface_properties (PHY-15 FR-EOP-14, AF-20): readiness of the coating assignments (optical values present, sourced, with their condition). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { electroOpticalOf } from './model';
import { isMissing, propertyOf } from './opticalProperty';
import type { CoatingAssignment } from './types';

type ItemStatus = 'pass' | 'warn' | 'fail';
const RANK: Readonly<Record<ItemStatus, number>> = { pass: 0, warn: 1, fail: 2 };

interface Item {
  readonly assignmentId: string;
  readonly entityId: string;
  readonly coating: string;
  readonly location: string;
  readonly status: ItemStatus;
  readonly findings: readonly { readonly code: string; readonly message: string; readonly severity: ItemStatus }[];
}

type Finding = Item['findings'][number];

/** The finding for one optical property of the coating: absent (error), needing a T (present), or unverified (warning). */
function propertyFinding(
  doc: CadDocument,
  coating: string,
  property: string,
  condition: Record<string, string>,
  severity: ItemStatus,
  ctx: ExecutionContext | undefined,
): Finding | null {
  const found = propertyOf(doc, coating, property, condition, {}, ctx);
  if (isMissing(found))
    return found.code === 'PROP_VARIABLE_MISSING'
      ? null
      : {
          code: 'EOP_SURFACE_PROPERTY_MISSING',
          message: `${property} ${JSON.stringify(condition)} unavailable: ${found.message}`,
          severity,
        };
  if (!(found.value >= 0 && found.value <= 1))
    return { code: 'EOP_PROPERTY_RANGE', message: `${property} ${found.value} is outside [0, 1]`, severity: 'fail' };
  return found.unverified.length > 0
    ? {
        code: 'EOP_PROPERTY_UNVERIFIED',
        message: `${property} ${JSON.stringify(condition)} is unverified: ${found.unverified.join('; ')}`,
        severity: 'warn',
      }
    : null;
}

function itemOf(doc: CadDocument, assignment: CoatingAssignment, ctx: ExecutionContext | undefined): Item {
  const record = Object.hasOwn(doc.materials, assignment.coating) ? doc.materials[assignment.coating]?.record : undefined;
  const findings: Finding[] = [];
  if (record?.productForm !== 'coating')
    findings.push({
      code: 'EOP_COATING_NOT_FOUND',
      message: `'${assignment.coating}' is missing or is not a coating record`,
      severity: 'fail',
    });
  else {
    if (assignment.location === 'exposed') {
      findings.push(
        ...[
          propertyFinding(doc, assignment.coating, 'emissivityIr', { opticalKind: 'hemispherical_total' }, 'fail', ctx),
          propertyFinding(doc, assignment.coating, 'absorptivitySolar', { lifeState: 'BOL' }, 'fail', ctx),
          propertyFinding(doc, assignment.coating, 'absorptivitySolar', { lifeState: 'EOL' }, 'warn', ctx),
        ].filter((finding): finding is Finding => finding !== null),
      );
    } else if (assignment.electrical === 'unknown')
      findings.push({
        code: 'EOP_COATING_UNKNOWN',
        message: `bonded-interface coating ${assignment.id}: electrical effect not declared, check_bonding cannot pass a joint across it`,
        severity: 'warn',
      });
  }
  const status = findings.reduce<ItemStatus>((worst, finding) => (RANK[finding.severity] > RANK[worst] ? finding.severity : worst), 'pass');
  return {
    assignmentId: assignment.id,
    entityId: assignment.entityId,
    coating: assignment.coating,
    location: assignment.location,
    status,
    findings,
  };
}

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant one item per coating assignment (in scope): an exposed coating needs emissivityIr (hemispherical_total) and absorptivitySolar BOL (missing = fail) and EOL (missing = warn), values in [0, 1], unverified values warn;
 *   a bonded-interface coating with an undeclared electrical effect warns; solids without any coating are NOT reported (which faces radiate is the thermal case's business, PHY-03 link not built); never a default value
 * @failure never refuses (an unknown entityIds entry is simply not matched and listed in data.unmatched)
 */
export const checkSurfaceProperties = defineCommand({
  name: 'check_surface_properties',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Readiness check of the coatings placed with assign_surface_coating: an exposed coating must have emissivityIr (condition opticalKind hemispherical_total) and absorptivitySolar for BOL (and EOL, a warning when missing) as PHY-01 models with values in [0, 1]; ' +
    'a missing value is EOP_SURFACE_PROPERTY_MISSING (never a guess), an unverified one EOP_PROPERTY_UNVERIFIED, a bonded-interface coating with an undeclared electrical effect EOP_COATING_UNKNOWN. ' +
    'Returns data { status: pass | warn | fail (worst item), items: [{ assignmentId, entityId, coating, location, status, findings }], counts, unmatched, reviewRequired: true }. Solids with no coating are not reported.',
  params: z.object({ entityIds: z.array(z.string()).optional().describe('Only the coatings on these solids. Omit for all.') }),
  run: (doc, { entityIds }, ctx): CommandResult => {
    const scope = entityIds === undefined ? null : new Set(entityIds);
    const assignments = Object.values(electroOpticalOf(doc).coatings).filter((item) => scope === null || scope.has(item.entityId));
    const items = assignments.map((assignment) => itemOf(doc, assignment, ctx));
    const status = items.reduce<ItemStatus>((worst, item) => (RANK[item.status] > RANK[worst] ? item.status : worst), 'pass');
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const covered = new Set(assignments.map((assignment) => assignment.entityId));
    const unmatched = (entityIds ?? []).filter((id) => !covered.has(id));
    const problems = items
      .filter((item) => item.status !== 'pass')
      .slice(0, 8)
      .map((item) => `${item.assignmentId} ${item.status} ${item.findings[0]?.code ?? ''}`);
    return report(
      doc,
      `check_surface_properties: ${status} - ${items.length} coating assignment(s)${problems.length > 0 ? `; ${problems.join('; ')}` : ''}.`,
      { status, items, counts, unmatched, reviewRequired: true },
    );
  },
});
