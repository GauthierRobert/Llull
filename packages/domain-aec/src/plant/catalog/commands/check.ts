/** `check_piping_catalog` (plant 01 PSC M1): dimensional rules of the standards over a catalogue. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { worstStatus, type CheckStatus } from '@core/model/checkResult';
import { BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { CATALOG_RULES, checkCatalogRules } from '../rules';
import { allCatalogs, findCatalog } from '../store';

const RANK: Readonly<Record<string, number>> = { fail: 0, warn: 1, info: 2 };

/**
 * @affects none; data = { catalogId, status, issues: [{ code, status, rule, ids, paths, values, message, remediation, findingKey }], counts, rulesRun, reviewRequired }
 * @invariant read-only; fails sort before warnings; unverified values always produce PSC_DATA_UNVERIFIED (warn); status is pass only with no finding
 * @failure unknown catalogue -> PSC_CATALOG_UNKNOWN
 */
export const checkPipingCatalog = defineCommand({
  name: 'check_piping_catalog',
  description:
    'Check a piping catalogue (bundled or imported) against dimensional rules of the standards. Rules: b169.lr90 (B16.9 long-radius 90 degree elbow centre-to-end = 1.5 x NPS +/- 2 mm, NPS 3/4 and up), ' +
    'b169.sr90 (short radius = 1.0 x NPS), b165.hole (B16.5 bolt hole = bolt diameter + 1/8 in), pipe.odMatch (butt-weld fitting end OD equals the ASME B36.10M / EN 10220 pipe OD +/- 0.2 mm), ' +
    'monotonic (OD, centre-to-end and bolt circle do not fall with size), provenance (every value cites a source), verified (values that are not grade A: PSC_DATA_UNVERIFIED). ' +
    'Each issue has a code (PSC_CATALOG_DIM_MISMATCH, PSC_PROVENANCE_MISSING, PSC_DATA_UNVERIFIED), the file path of the value (families.0.sizes.0.centreToEnd), expected and found values and a fix. ' +
    'Results are for a qualified reviewer (reviewRequired true). Next: fix the file and import_piping_catalog with replace:true.',
  params: z.object({
    catalogId: z.string().describe('Catalogue id, or id@version. Default: the bundled llull-open-piping.').optional(),
    rules: z.array(z.enum(CATALOG_RULES)).describe('Rules to run. Default: all.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { catalogId = BUNDLED_CATALOG_ID, rules = [] }): CommandResult => {
    const catalog = findCatalog(doc, catalogId);
    if (catalog === undefined)
      return refuse(
        doc,
        'check_piping_catalog',
        'PSC_CATALOG_UNKNOWN',
        `no catalogue "${catalogId}" (available: ${allCatalogs(doc)
          .map((c) => c.id)
          .join(', ')})`,
        [catalogId],
        ['catalogId'],
      );
    const issues = checkCatalogRules(catalog, rules).sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
    const status: CheckStatus = worstStatus(issues.map((issue) => issue.status));
    const fails = issues.filter((issue) => issue.status === 'fail').length;
    const warns = issues.filter((issue) => issue.status === 'warn').length;
    return report(
      doc,
      `check_piping_catalog: ${catalog.id}@${catalog.version} ${status} (${fails} fail, ${warns} warn): ${
        issues
          .slice(0, 3)
          .map((issue) => issue.code)
          .join(', ') || 'no findings'
      }.`,
      {
        catalogId: catalog.id,
        version: catalog.version,
        status,
        issues,
        counts: { fail: fails, warn: warns },
        rulesRun: rules.length === 0 ? CATALOG_RULES : rules,
        reviewRequired: true,
      },
    );
  },
});
