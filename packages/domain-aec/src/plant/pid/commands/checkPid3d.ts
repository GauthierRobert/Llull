import { getBuilding } from '@aec/building/model';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { check3d } from '../link3d/check';
import { P3D_RULES } from '../link3d/finding';
import { getPid } from '../state';

/**
 * @affects nothing (read-only query of doc.plant.pid and doc.building)
 * @invariant explicit link_pid_item pairs win over tag matching; equipment pair on tag = mark, lines on line number; hash join, linear in both sides; every finding is an error so status is fail on any mismatch; reviewRequired is always false (drawing / model consistency, no safety verdict)
 * @failure none: a document without a P&ID or without a building reports every present item as unmatched
 */
export const checkPid3d = defineCommand({
  name: 'check_pid_3d',
  description:
    'Compare the P&ID (doc.plant.pid) with the 3D plant model, read-only. 3D side (MVP): building equipment (add_equipment, its `mark` is the tag) and pipe runs (add_pipe_run; runs sharing a `line` number are one line). ' +
    'Pairs are explicit links first (link_pid_item), then normalised tag = mark for equipment and line number = pipe `line` for lines. Codes (all errors): P3D_UNPLACED (P&ID equipment / line / tagged inline item with no 3D match; inline components never match yet: ' +
    'the 3D model has no inline objects), P3D_NOT_IN_PID (3D equipment with a mark or pipe line number with no P&ID match), P3D_SIZE_MISMATCH (set of P&ID segment DN differs from the set of 3D run DN; skipped when either side has no DN), ' +
    'P3D_CONNECTIVITY_MISMATCH (the unordered pair of equipment tags, plus nozzle sub-tags when the 3D from / to is "TAG:NOZZLE", differs; compared only when both P&ID ends are nozzles and the 3D run has from and to), ' +
    'P3D_TAG_AMBIGUOUS (several candidates for one tag; nothing is paired, use link_pid_item). Not built (need 01 PSC, 02 RTE, 03 EQP data): P3D_SPEC_MISMATCH, P3D_CLASS_MISMATCH, P3D_INLINE_ORDER_MISMATCH. ' +
    'Returns data = { check: "pid_3d", status (fail | pass), items [{ code, status, severity, ids, pidIds, elementIds, item, message, findingKey, remediation, values }], countsByCode (every built code, zeros kept), ' +
    'matched { equipment[] tags, lines[] line numbers, inline[] }, unmatchedPid [{ id, kind, label, reason }], unmatched3d [{ ids, category, label, reason }], summary { errors, warnings, infos, reviewRequired: false }, rulesRun, provenance }. ' +
    'Next: fix the model or P&ID named by `remediation`, or pair with link_pid_item; check_pid checks the drawing alone.',
  params: z.object({
    scope: z
      .enum(['all', 'equipment', 'lines', 'inline'])
      .optional()
      .describe('What to compare: "equipment", "lines" (P&ID lines vs pipe runs), "inline" (tagged inline items) or "all" (default).'),
    normaliseTags: z
      .boolean()
      .optional()
      .describe(
        'Default true: tags and line numbers match case-insensitively ignoring spaces, "-" and "_" ("p101" = "P-101"). false = exact match after trimming.',
      ),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const normaliseTags = params.normaliseTags !== false;
    const scope = params.scope ?? 'all';
    const pid = getPid(doc);
    const result = check3d(pid, getBuilding(doc), scope, normaliseTags);
    const errors = result.findings.length;
    const status = errors > 0 ? 'fail' : 'pass';
    const countsByCode = Object.fromEntries(P3D_RULES.map((code) => [code, result.findings.filter((f) => f.code === code).length]));
    const matchedCount = result.matched.equipment.length + result.matched.lines.length;
    return report(
      doc,
      `check_pid_3d: ${status} — ${errors} finding(s), ${matchedCount} matched (${result.matched.equipment.length} equipment, ${result.matched.lines.length} lines), ` +
        `${result.unmatchedPid.length} P&ID item(s) unmatched, ${result.unmatched3d.length} 3D object(s) unmatched (scope ${scope})` +
        (errors > 0 ? `; first: ${result.findings[0]?.message ?? ''}` : ''),
      {
        check: 'pid_3d',
        status,
        items: result.findings,
        countsByCode,
        matched: result.matched,
        unmatchedPid: result.unmatchedPid,
        unmatched3d: result.unmatched3d,
        summary: { errors, warnings: 0, infos: 0, reviewRequired: false },
        rulesRun: P3D_RULES,
        provenance: {
          method: 'TECHNICAL_SPEC 04 PID §5.6 (MVP subset) over doc.plant.pid and doc.building',
          tagNormalisation: normaliseTags ? 'upper case, spaces / "-" / "_" removed' : 'trim only',
          links: Object.keys(pid.links ?? {}).length,
          scope,
        },
        reviewRequired: false,
      },
    );
  },
});
