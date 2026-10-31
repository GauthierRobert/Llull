import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { refusePid } from '../dexpi/codes';
import { getPid } from '../state';
import { PID_RULES, type Finding } from '../checks/finding';
import { runChecks } from '../checks/runChecks';

/**
 * @affects nothing (read-only query of `doc.plant.pid`)
 * @invariant 16 rules (TECHNICAL_SPEC §5.5), each pass linear in the items; findings sorted errors first, then rule order, natural item label, key; findingKey = pid:<code>:<sorted ids> is stable; status fail with any error, warn with any warning, else pass; accepted findings are hidden unless includeAccepted
 * @failure sheet (number or id) not found -> PID_SHEET_NOT_FOUND; a document without a P&ID passes with no findings
 */
export const checkPid = defineCommand({
  name: 'check_pid',
  description:
    'Check the P&ID of the document (doc.plant.pid) for schematic faults, read-only. Rules (code, severity): PID_LINE_NON_TERMINATING (error; a segment end is free and not marked update_pid_item set.attributes.endOfLine on the segment), ' +
    'PID_COMPONENT_UNCONNECTED (error; an inline item port has no segment; a blind flange / cap may leave its far port open), PID_NOZZLE_UNCONNECTED (warning; a nozzle with no line), PID_NOZZLE_UNCONNECTED_ACCESS (info; the same for access nozzles / manholes and nozzles marked set.attributes.spare="true"), ' +
    'PID_EQUIPMENT_UNCONNECTED (error; a Tank, PressureVessel or ProcessColumn none of whose nozzles has a line), PID_SIZE_MISMATCH (error; inline dn differs from its segment dn, a reducer is exempt), PID_SPEC_MISMATCH (error; inline pipingClass differs from its segment, a spec break is exempt: class SpecBreak or attribute specBreak), ' +
    'PID_FLOW_DIRECTION_CONFLICT (error; segments meeting at an inline item all flow in or all out, or a check valve against the flow), PID_OPC_UNRESOLVED (error; no partner connector of the opposite direction with the same pairKey on another sheet), PID_TAG_DUPLICATE (error; one tag on several items), ' +
    'PID_SEGMENT_INVALID (error; a drawn segment is not one chain, or a port is used by several segment ends), PID_CONTROL_VALVE_NO_ACTUATOR (warning; an operated valve without actuating system, or an actuating system without controller), ' +
    'PID_SAFETY_VALVE_NO_SET_PRESSURE (warning, reviewRequired; a safety / relief valve without SetPressureHigh), PID_LINE_NUMBER_MISSING (warning), PID_INSTRUMENT_UNCONNECTED (warning; no measuring / signal line, not a loop partner), PID_TAG_NONSTANDARD (info; instrument letters outside ISA 5.1). ' +
    'Returns data = { check: "pid", status (fail | warn | pass), items (errors first, then warnings, infos; each by rule order) [{ code, status, severity, ids, tags, sheet, item, message, findingKey, remediation, values, reviewRequired? }], countsByCode (every rule run, zero included), ' +
    'summary { errors, warnings, infos, reviewRequired, accepted }, rulesRun, provenance }. Each finding names its fix in `remediation`. `sheet` limits the check to one sheet, `rules` to some codes. Refusal: PID_SHEET_NOT_FOUND. ' +
    'Next: fix the findings with update_pid_item / add_pid_line / reverse_pid_flow / delete_pid_item, then check again; pid_report lists the model.',
  params: z.object({
    sheet: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Check only this sheet: its number (e.g. "PID-001") or its id. Omit for the whole P&ID.'),
    rules: z.array(z.enum(PID_RULES)).optional().describe('Run only these rule codes (e.g. ["PID_SIZE_MISMATCH"]). Omit for all 16 rules.'),
    includeAccepted: z
      .boolean()
      .optional()
      .describe(
        'true = also list findings whose findingKey is in the accepted findings of the P&ID (hidden by default); counted in summary.accepted either way.',
      ),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const pid = getPid(doc);
    const sheet =
      params.sheet === undefined
        ? undefined
        : (pid.sheets[params.sheet] ?? Object.values(pid.sheets).find((s) => s.number === params.sheet));
    if (params.sheet !== undefined && sheet === undefined)
      return refusePid(doc, 'check_pid', 'PID_SHEET_NOT_FOUND', `no sheet "${params.sheet}"`, [], ['sheet']);
    const run = runChecks(pid, { sheetId: sheet?.id, rules: params.rules, includeAccepted: params.includeAccepted === true });
    const count = (severity: Finding['severity']): number => run.findings.filter((f) => f.severity === severity).length;
    const errors = count('error');
    const warnings = count('warning');
    const infos = count('info');
    const reviewRequired = run.findings.filter((f) => f.reviewRequired === true).length;
    const countsByCode = Object.fromEntries(run.rulesRun.map((code) => [code, run.findings.filter((f) => f.code === code).length]));
    const status = errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
    return report(
      doc,
      `check_pid: ${status} — ${errors} errors, ${warnings} warnings, ${infos} infos${reviewRequired > 0 ? `, ${reviewRequired} need review` : ''} ` +
        `(${run.rulesRun.length} rules${sheet === undefined ? '' : `, sheet ${sheet.number}`})` +
        (errors > 0 ? `; first: ${run.findings.find((f) => f.severity === 'error')?.message ?? ''}` : ''),
      {
        check: 'pid',
        status,
        items: run.findings,
        countsByCode,
        summary: { errors, warnings, infos, reviewRequired, accepted: run.accepted },
        rulesRun: run.rulesRun,
        provenance: {
          method: 'TECHNICAL_SPEC 04 PID §5.5 rule set over doc.plant.pid',
          convention: pid.convention,
          tagNormalisation: 'trim, collapse spaces, upper case',
          imports: (pid.imports ?? []).map((record) => ({ format: record.format, version: record.version, sha256: record.sha256 })),
        },
        reviewRequired: reviewRequired > 0,
      },
    );
  },
});
