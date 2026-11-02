import { getBuilding } from '@aec/building/model';
import { getPiping } from '@aec/plant/piping/model';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { check3d } from '../link3d/check';
import { P3D_RULES } from '../link3d/finding';
import { getPid } from '../state';

/**
 * @affects nothing (read-only query of doc.plant.pid, doc.building and doc.plant.piping)
 * @invariant explicit link_pid_item pairs win over tag matching; equipment pair on tag = mark, lines on line number; hash join, linear in both sides, the inline-order LCS bounded per line with a coded skip above 250 000 cells; a comparison that cannot be made is a coded skip, never a pass; every finding is an error so status is fail on any mismatch; reviewRequired is always false (drawing / model consistency, no safety verdict)
 * @failure none: a document without a P&ID or without a building reports every present item as unmatched
 */
export const checkPid3d = defineCommand({
  name: 'check_pid_3d',
  description:
    'Compare the P&ID (doc.plant.pid) with the 3D plant model, read-only. 3D side: building equipment (add_equipment / add_vessel, its `mark` is the tag), legacy pipe runs (add_pipe_run; runs sharing a `line` number are one line) and 02 RTE routed lines (create_pipeline + route_pipe: the line number, spec, DN, nozzle / tie-in ends and the tagged inline valves / reducers). ' +
    'Pairs are explicit links first (link_pid_item), then normalised tag = mark for equipment, line number = pipe `line` or routed lineNumber for lines (legacy pipes and the routed line of one number are one 3D line), inline tag = inline component tag. Codes (all errors): ' +
    'P3D_UNPLACED (P&ID equipment / line / tagged inline item with no 3D match), P3D_NOT_IN_PID (3D equipment, pipe line number or tagged inline component with no P&ID match), P3D_SIZE_MISMATCH (set of P&ID segment DN differs from the set of 3D DN; skipped when either side has none), ' +
    'P3D_SPEC_MISMATCH (the P&ID piping class IS the 01 PSC spec id: the set of segment / line piping classes differs from the set of 3D spec ids, normalised like tags), ' +
    'P3D_CONNECTIVITY_MISMATCH (the unordered pair of equipment tags, plus nozzle sub-tags when the 3D from / to is "TAG:NOZZLE" or a routed nozzle port, differs; compared only when both P&ID ends are nozzles and the 3D line has from and to), ' +
    'P3D_CLASS_MISMATCH (paired inline item: DEXPI class vs the catalogue component type, GateValve = valveGate, GlobeValve = valveGlobe, BallValve = valveBall, ButterflyValve = valveButterfly, PlugValve = valvePlug, SwingCheckValve = valveCheck, OperatedValve = any valve, PipeReducer = reducerConcentric | reducerEccentric; paired equipment: a 03 EQP vessel stands for PressureVessel / Tank / ProcessColumn / ColumnSection when vertical and PressureVessel / Tank / TubularHeatExchanger when horizontal), ' +
    'P3D_INLINE_ORDER_MISMATCH (on a paired line, the order of the tags present on both sides differs; the 3D order is also tried reversed; reported with the longest common sequence and the out-of-place P&ID tags; bounded to 250 000 tag pairs per line), ' +
    'P3D_TAG_AMBIGUOUS (several candidates for one tag; nothing is paired, use link_pid_item). A comparison that cannot be made (no piping class, no spec binding, class without a mapping row, equipment without a vessel kind, sequence over the bound) is listed in data.skipped with a reason and is never a pass. ' +
    'Returns data = { check: "pid_3d", status (fail | pass), items [{ code, status, severity, ids, pidIds, elementIds, item, message, findingKey, remediation, values }], countsByCode (every code, zeros kept), skipped [{ code, reason, item, pidIds, elementIds, detail }], ' +
    'matched { equipment[] tags, lines[] line numbers, inline[] tags }, unmatchedPid [{ id, kind, label, reason }], unmatched3d [{ ids, category, label, reason }], summary { errors, warnings, infos, reviewRequired: false }, rulesRun, provenance }. ' +
    'Next: fix the model or P&ID named by `remediation`, or pair with link_pid_item; check_pid checks the drawing alone.',
  params: z.object({
    scope: z
      .enum(['all', 'equipment', 'lines', 'inline'])
      .optional()
      .describe(
        'What to compare: "equipment", "lines" (P&ID lines vs 3D lines: size, spec, ends), "inline" (tagged inline items: placement, class, and the inline order on paired lines) or "all" (default).',
      ),
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
    const result = check3d(pid, getBuilding(doc), getPiping(doc), scope, normaliseTags);
    const errors = result.findings.length;
    const status = errors > 0 ? 'fail' : 'pass';
    const countsByCode = Object.fromEntries(P3D_RULES.map((code) => [code, result.findings.filter((f) => f.code === code).length]));
    const matchedCount = result.matched.equipment.length + result.matched.lines.length;
    return report(
      doc,
      `check_pid_3d: ${status} — ${errors} finding(s), ${matchedCount} matched (${result.matched.equipment.length} equipment, ${result.matched.lines.length} lines), ` +
        `${result.unmatchedPid.length} P&ID item(s) unmatched, ${result.unmatched3d.length} 3D object(s) unmatched, ${result.skipped.length} comparison(s) skipped (scope ${scope})` +
        (errors > 0 ? `; first: ${result.findings[0]?.message ?? ''}` : ''),
      {
        check: 'pid_3d',
        status,
        items: result.findings,
        countsByCode,
        skipped: result.skipped,
        matched: result.matched,
        unmatchedPid: result.unmatchedPid,
        unmatched3d: result.unmatched3d,
        summary: { errors, warnings: 0, infos: 0, reviewRequired: false },
        rulesRun: P3D_RULES,
        provenance: {
          method: 'TECHNICAL_SPEC 04 PID §5.6 over doc.plant.pid, doc.building and doc.plant.piping',
          tagNormalisation: normaliseTags ? 'upper case, spaces / "-" / "_" removed' : 'trim only',
          links: Object.keys(pid.links ?? {}).length,
          scope,
        },
        reviewRequired: false,
      },
    );
  },
});
