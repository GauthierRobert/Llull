import type { PmiItem } from '../../model/pmi';
import type { PmiTolerance } from '../../model/pmi';
import { sizeNominal } from '../../geometry/pmiText';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { currentContext } from '../context';
import { type Finding, finding, toleranceFindings } from './rules';
import { pmiItems, pmiOf } from './pmiOps';
import { createSolidLookup, refreshItem } from './refresh';

const entityOf = (item: PmiItem, items: Readonly<Record<string, PmiItem>>): string | undefined => {
  switch (item.kind) {
    case 'location_dimension':
      return item.to.entityId;
    case 'note':
      return item.feature?.entityId;
    case 'geometric_tolerance': {
      if ('feature' in item.target) return item.target.feature.entityId;
      const target = items[item.target.pmiId];
      return target !== undefined && 'feature' in target ? target.feature.entityId : undefined;
    }
    default:
      return item.feature.entityId;
  }
};

const toleranceOf = (item: PmiItem): PmiTolerance | undefined =>
  item.kind === 'size_dimension' || item.kind === 'location_dimension' ? item.tolerance : undefined;

/** Findings of the data itself (no kernel): inverted limits, nominal outside limits, dangling targets, duplicate datums, unused datums. */
function dataFindings(items: readonly PmiItem[], byId: Readonly<Record<string, PmiItem>>): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, string>();
  const referenced = new Set<string>();
  for (const item of items) {
    const tolerance = toleranceOf(item);
    if (tolerance !== undefined && tolerance.type !== 'basic' && tolerance.lower > tolerance.upper)
      out.push(
        finding('error', 'GDT_LIMITS_INVERTED', [item.id], `lower ${tolerance.lower} exceeds upper ${tolerance.upper}`, ['tolerance']),
      );
    if (item.kind === 'size_dimension' && tolerance?.type === 'limits') {
      const nominal = sizeNominal(item);
      if (nominal !== undefined && (nominal < tolerance.lower - 1e-9 || nominal > tolerance.upper + 1e-9))
        out.push(
          finding(
            'warning',
            'GDT_NOMINAL_OUTSIDE_LIMITS',
            [item.id],
            `measured ${nominal} is outside the limits ${tolerance.lower}-${tolerance.upper}`,
          ),
        );
    }
    if (item.kind === 'datum_feature') {
      const key = `${item.feature.entityId}/${item.label}`;
      const first = seen.get(key);
      if (first !== undefined)
        out.push(
          finding(
            'error',
            'GDT_DATUM_DUPLICATE',
            [first, item.id],
            `datum '${item.label}' is defined twice on '${item.feature.entityId}'`,
            ['label'],
          ),
        );
      else seen.set(key, item.id);
    }
    if (item.kind === 'geometric_tolerance') {
      if ('pmiId' in item.target && !Object.hasOwn(byId, item.target.pmiId))
        out.push(finding('error', 'GDT_TARGET_DANGLING', [item.id], `target '${item.target.pmiId}' is not a PMI item`, ['target.pmiId']));
      out.push(...toleranceFindings(item, byId));
      const entity = entityOf(item, byId);
      for (const datum of item.datums) referenced.add(`${entity}/${datum.label}`);
    }
    if (item.kind === 'datum_target') referenced.add(`${item.feature.entityId}/${item.label}`);
  }
  for (const item of items)
    if (item.kind === 'datum_feature' && !referenced.has(`${item.feature.entityId}/${item.label}`))
      out.push(finding('warning', 'GDT_DATUM_UNUSED', [item.id], `datum ${item.label} is never referenced`));
  return out;
}

/**
 * @affects nothing — read-only
 * @invariant deterministic order: item creation order, then the document-level findings; every finding { code, severity, pmiIds, message, remediation, paths }
 * @failure none: no PMI gives zero counts; a kernel without exact topology reports resolution 'not_run' instead of failing
 */
export const checkPmi = defineCommand({
  name: 'check_pmi',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Check the PMI of the document (read-only). Re-resolves every feature on the CURRENT B-rep (so it catches PMI broken by a model edit: ' +
    'GDT_FEATURE_UNRESOLVED, GDT_SURFACE_TYPE_CHANGED) when an OCC kernel is present, else reports resolution "not_run". Built-in logical ' +
    'rules (not quoted from a standard): undefined / duplicate / repeated / too many datums, non-positive zones, MMC or LMC on a non feature ' +
    'of size, Ø zone on a plane, datum references on form tolerances, inverted limits, dangling targets; warnings for unused datums, nominal ' +
    'outside limits, items awaiting engineer review (GDT_REVIEW_REQUIRED) and unverified input. Set requireCoverage to also warn about faces of a ' +
    'toleranced solid no item covers. Returns data { status pass|warn|fail, errors[], warnings[] each { code, pmiIds, message, remediation, ' +
    'paths }, stats { items, reviewRequired, unverified }, resolution, ruleTable }. No customer rule table is built: characteristic and modifier ' +
    'permissions per standard are NOT checked (ruleTable "none").',
  params: z.object({
    entityId: z.string().optional().describe('Only check the items of this solid. Default: all PMI.'),
    rules: z
      .enum(['builtin', 'builtin+table'])
      .optional()
      .describe('builtin (default). builtin+table needs a customer rule table, none is installed: it adds an unverified warning.'),
    requireCoverage: z
      .boolean()
      .optional()
      .describe(
        'true = warn about faces of a toleranced solid covered by no PMI item (GDT_FEATURE_UNTOLERANCED) unless a general note exists. Default false.',
      ),
  }),
  run: (doc, { entityId, rules = 'builtin', requireCoverage = false }, ctx): CommandResult => {
    const all = pmiItems(doc);
    const byId = pmiOf(doc).items;
    const items = entityId === undefined ? all : all.filter((item) => entityOf(item, byId) === entityId);
    const lookup = createSolidLookup(doc, (ctx ?? currentContext()).kernel);
    const findings: Finding[] = [];
    let notRun = false;
    const refreshed: PmiItem[] = [];
    for (const item of items) {
      const result = refreshItem(item, lookup);
      notRun = notRun || result.notRun;
      refreshed.push(result.item);
      findings.push(...result.findings);
    }
    findings.push(...dataFindings(items, byId));
    const needReview = items.filter((item) => item.review.required);
    if (needReview.length > 0)
      findings.push(
        finding(
          'warning',
          'GDT_REVIEW_REQUIRED',
          needReview.map((item) => item.id),
          `${needReview.length} item(s) are not approved by a qualified engineer`,
        ),
      );
    const unverified = items.filter((item) => item.unverified !== undefined);
    if (unverified.length > 0)
      findings.push(
        finding(
          'warning',
          'GDT_UNVERIFIED_INPUT',
          unverified.map((item) => item.id),
          unverified.map((item) => `${item.id}: ${item.unverified?.reason ?? ''}`).join('; '),
        ),
      );
    if (items.length > 0)
      findings.push(
        finding(
          'warning',
          'GDT_UNVERIFIED_INPUT',
          [],
          'no customer rule table is installed: permitted characteristics and modifiers per standard are not checked',
        ),
      );
    if (rules === 'builtin+table')
      findings.push(
        finding(
          'warning',
          'GDT_TABLE_RULE',
          [],
          'rules builtin+table requested but no rule table is installed; only the built-in rules ran',
        ),
      );
    if (requireCoverage && pmiOf(doc).generalToleranceNote === undefined) findings.push(...coverageFindings(doc, refreshed, lookup));
    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');
    const status = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
    const stats = { items: items.length, reviewRequired: needReview.length, unverified: unverified.length };
    const summary =
      `check_pmi: ${status} — ${items.length} item(s), ${errors.length} error(s), ${warnings.length} warning(s)` +
      `${needReview.length > 0 ? `; ${needReview.length} item(s) not approved by a qualified engineer (review required)` : ''}` +
      `${notRun ? '; feature resolution not_run (no exact kernel)' : ''}` +
      `${errors.length > 0 ? `; first: ${errors[0]?.code} — ${errors[0]?.message}` : ''}.`;
    return report(doc, summary, { status, errors, warnings, stats, resolution: notRun ? 'not_run' : 'resolved', ruleTable: 'none' });
  },
});

/** Faces of solids that carry PMI but are covered by no item feature. */
function coverageFindings(doc: CadDocument, items: readonly PmiItem[], lookup: ReturnType<typeof createSolidLookup>): Finding[] {
  const covered = new Map<string, Set<number>>();
  const mark = (entity: string, indices: readonly number[]): void => {
    covered.set(entity, new Set([...(covered.get(entity) ?? []), ...indices]));
  };
  for (const item of items) {
    const features =
      item.kind === 'location_dimension'
        ? [item.from, item.to]
        : item.kind === 'geometric_tolerance'
          ? 'feature' in item.target
            ? [item.target.feature]
            : []
          : item.kind === 'note'
            ? item.feature === undefined
              ? []
              : [item.feature]
            : [item.feature];
    for (const feature of features) mark(feature.entityId, feature.faceIndices);
    if (item.kind === 'geometric_tolerance' && 'pmiId' in item.target) {
      const target = pmiOf(doc).items[item.target.pmiId];
      if (target !== undefined && 'feature' in target) mark(target.feature.entityId, target.feature.faceIndices);
    }
  }
  const out: Finding[] = [];
  for (const [entity, marked] of covered) {
    const solid = lookup(entity);
    if (solid === null || 'code' in solid) continue;
    const missing = solid.details.map((face) => face.index).filter((index) => !marked.has(index));
    if (missing.length > 0)
      out.push(
        finding(
          'warning',
          'GDT_FEATURE_UNTOLERANCED',
          [],
          `'${entity}' faces ${missing.join(', ')} are covered by no PMI item and there is no general tolerance note`,
        ),
      );
  }
  return out;
}
