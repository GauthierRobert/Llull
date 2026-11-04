import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import { isoUtc } from '../../../shared/isoUtc';
import { runChecks } from '../checks/runChecks';
import { refusePid } from '../dexpi/codes';
import type { PidAcceptance } from '../model';
import { getPid, withPid } from '../state';

const ACT = 'pid:accept_pid_finding';

/**
 * @affects plant.pid.acceptances[findingKey] (one acceptance: reason, who, when, rule code and severity; a signed one also the signature id and the signed payload hash); a metaHistory command: no feature step, acceptances are carried across a history replay
 * @invariant an accepted finding is hidden by check_pid (counted in summary.accepted); an error-severity finding needs a human signature verified AND spent by ctx.humanSignature over { act, findingKey, reason, rule code, at, documentUid }, checked after the finding lookup so a refusal never spends it; warnings and infos are accepted by name without a signature
 * @failure unknown findingKey (not an open or accepted finding of the current P&ID) -> PID_FINDING_NOT_FOUND; already accepted -> PID_PARAM_INVALID; a warning / info without `by` -> PID_PARAM_INVALID; an error without a valid human signature -> PID_HUMAN_GATE; document unchanged
 */
export const acceptPidFinding = defineCommand({
  name: 'accept_pid_finding',
  description:
    'Accept a finding of check_pid so that it is no longer listed (a false positive, a known exception), recording the reason, who and when. findingKey is the stable key printed by check_pid ("pid:<rule>:<ids>"). ' +
    'A warning or info is accepted by name: pass `by` (self-asserted). An ERROR-severity finding is a HUMAN act that an agent cannot perform: `confirmation` must be a signature object produced by a human in the desktop app ' +
    '(with a nonce field) over the act, the findingKey, the reason, the rule code and `at`, verified and spent once by the signing port; the signer becomes `by`. The acceptance is stored in doc.plant.pid.acceptances, check_pid hides it ' +
    '(includeAccepted lists it) and a sheet with only accepted errors can be issued for construction. `at` is host-filled and part of what is signed. This is a document-state command, not a recipe step: a history replay keeps the acceptances and never re-runs a signature. ' +
    'Returns data = { findingKey, code, severity, reason, by, at, signed, signatureId?, payloadSha256?, reviewRequired }. Refusals (document unchanged): PID_FINDING_NOT_FOUND, PID_PARAM_INVALID, PID_HUMAN_GATE.',
  annotations: { metaHistory: true },
  params: z.object({
    findingKey: z
      .string()
      .trim()
      .min(1)
      .describe('The finding to accept: its findingKey from check_pid, e.g. "pid:PID_NOZZLE_UNCONNECTED:pid-1.4".'),
    reason: z.string().trim().min(1).max(500).describe('Why the finding is accepted (stored and shown in the acceptance record).'),
    by: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Who accepts a warning or info (self-asserted, stored as given). Not used for an error: the verified signer is recorded instead.',
      ),
    at: isoUtc.describe(
      'When the acceptance happened: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it and it is part of the signed payload; commands never read a clock.',
    ),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Human confirmation for an error-severity finding: a signature object (with a nonce field) produced in the desktop app over this act. An agent cannot give it: true or a missing value is refused with PID_HUMAN_GATE.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const pid = getPid(doc);
    const fail = (code: string, message: string, paths: readonly string[], ids: readonly string[] = []): CommandResult =>
      refusePid(doc, 'accept_pid_finding', code, message, ids, paths);
    const finding = runChecks(pid, { includeAccepted: true }).findings.find((candidate) => candidate.findingKey === params.findingKey);
    if (finding === undefined)
      return fail('PID_FINDING_NOT_FOUND', `no finding "${params.findingKey}" in the current P&ID (check_pid lists the keys)`, [
        'findingKey',
      ]);
    if (Object.hasOwn(pid.acceptances ?? {}, params.findingKey))
      return fail('PID_PARAM_INVALID', `finding "${params.findingKey}" is already accepted`, ['findingKey'], finding.ids);
    const gated = finding.severity === 'error';
    if (!gated && params.by === undefined)
      return fail('PID_PARAM_INVALID', 'a warning or info is accepted by name: give `by`', ['by'], finding.ids);
    let signed: { readonly signer: string; readonly signatureId: string; readonly payloadSha256: string } | null = null;
    if (gated) {
      const details = withDocumentUid({ reason: params.reason, code: finding.code, at: params.at }, doc);
      const outcome = humanGate(ctx?.humanSignature ?? null, ACT, [params.findingKey], params.confirmation, details);
      if (!outcome.cleared)
        return fail('PID_HUMAN_GATE', `accept_pid_finding of an error is a human act: ${outcome.reason}`, ['confirmation'], finding.ids);
      const nonce = (params.confirmation as { nonce: string }).nonce;
      signed = {
        signer: outcome.signer,
        signatureId: outcome.signatureId,
        payloadSha256: humanGatePayload(ACT, [params.findingKey], details, nonce),
      };
    }
    const by = signed?.signer ?? (params.by as string);
    const acceptance: PidAcceptance = {
      reason: params.reason,
      by,
      at: params.at,
      code: finding.code,
      severity: finding.severity,
      ...(signed === null ? {} : { signatureId: signed.signatureId, payloadSha256: signed.payloadSha256 }),
    };
    return {
      document: withPid(doc, { ...pid, acceptances: { ...pid.acceptances, [params.findingKey]: acceptance } }),
      summary: `accept_pid_finding: ${finding.code} on ${finding.item} accepted by ${by}${signed === null ? '' : ` (signed, ${signed.signatureId})`}: ${params.reason}`,
      affected: [...finding.ids],
      data: {
        findingKey: params.findingKey,
        code: finding.code,
        severity: finding.severity,
        reason: params.reason,
        by,
        at: params.at,
        signed: signed !== null,
        ...(signed === null ? {} : { signatureId: signed.signatureId, payloadSha256: signed.payloadSha256 }),
        reviewRequired: signed === null,
      },
    };
  },
});
