/**
 * Plant 04 PID-FU: the human gate of the P&ID (FR-PID-70 / 71, AF-33 / 34): accept_pid_finding (errors need a human signature) and issue_pid_sheet
 * (issued_for_construction is human-gated). Bound to the document (GATE-UID), never spent on a refusal, kept across a history replay.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { getPid } from '@aec/plant/pid/state';
import { pidErrors } from '@aec/plant/pid/validate';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectBoundToDocument } from '../../../helpers/documentBinding';
import { feedPump, runSteps } from './authoringFixtures';

const AT = '2026-11-02T09:30:00Z';

interface CheckData {
  status: string;
  items: Array<{ code: string; severity: string; findingKey: string }>;
  summary: { errors: number; accepted: number };
}
const check = (doc: CadDocument, params: Record<string, unknown> = {}): CheckData => data<CheckData>(doc, 'check_pid', params);

/** Accepts any confirmation that carries a nonce, records every payload it was asked about and spends each nonce once. */
function recordingPort(): { port: HumanSignaturePort; seen: string[]; spent: Set<string> } {
  const seen: string[] = [];
  const spent = new Set<string>();
  const port: HumanSignaturePort = {
    verify: (confirmation, payload) => {
      seen.push(payload);
      return typeof confirmation === 'object' && confirmation !== null ? { signer: 'alice', signatureId: `sig-${seen.length}` } : null;
    },
    spend: (confirmation, payload) => {
      const key = `${(confirmation as { nonce: string }).nonce}:${payload}`;
      if (spent.has(key)) return false;
      spent.add(key);
      return true;
    },
  };
  return { port, seen, spent };
}
const ctxOf = (port: HumanSignaturePort): ExecutionContext => ({ ...defaultContext(), humanSignature: port });

/** A sheet with a nozzle-less tank and a pump: `feedPump` carries one error (the off-page connector has no partner) and some warnings. */
const errorOf = (doc: CadDocument): { findingKey: string; code: string } => {
  const first = check(doc).items.find((item) => item.severity === 'error');
  if (first === undefined) throw new Error('the fixture has no error finding');
  return first;
};
const warningOf = (doc: CadDocument): { findingKey: string; code: string } => {
  const first = check(doc).items.find((item) => item.severity === 'warning');
  if (first === undefined) throw new Error('the fixture has no warning finding');
  return first;
};
const cleanSheet = (): CadDocument => runSteps([{ command: 'create_pid_sheet', params: { number: 'PID-009', paper: 'A3' } }]).doc;

describe('accept_pid_finding', () => {
  const doc = feedPump();

  it('a warning is accepted by name without a signature: check_pid hides it, counts it and lists it with includeAccepted', () => {
    const warning = warningOf(doc);
    const before = check(doc);
    const result = execute(doc, 'accept_pid_finding', { findingKey: warning.findingKey, reason: 'spare nozzle', by: 'agent-7', at: AT });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.data).toMatchObject({ code: warning.code, severity: 'warning', by: 'agent-7', signed: false, reviewRequired: true });
    const after = check(result.document);
    expect(after.items.map((item) => item.findingKey)).not.toContain(warning.findingKey);
    expect(after.summary.accepted).toBe(1);
    expect(after.items.length).toBe(before.items.length - 1);
    expect(check(result.document, { includeAccepted: true }).items.map((item) => item.findingKey)).toContain(warning.findingKey);
    expect(getPid(result.document).acceptances?.[warning.findingKey]).toEqual({
      reason: 'spare nozzle',
      by: 'agent-7',
      at: AT,
      code: warning.code,
      severity: 'warning',
    });
    expect(result.document.featureHistory.some((step) => step.name === 'accept_pid_finding')).toBe(false);
  });

  it('an error needs a human signature: no confirmation, true, no port and a port that refuses are PID_HUMAN_GATE and nothing is stored', () => {
    const error = errorOf(doc);
    const params = { findingKey: error.findingKey, reason: 'partner sheet is drawn later', at: AT };
    expectRefusal(doc, 'accept_pid_finding', params, 'PID_HUMAN_GATE', 'confirmation');
    expectRefusal(doc, 'accept_pid_finding', { ...params, confirmation: true }, 'PID_HUMAN_GATE', 'confirmation');
    expectRefusal(doc, 'accept_pid_finding', { ...params, confirmation: { nonce: 'n' } }, 'PID_HUMAN_GATE', 'confirmation');
    const deaf: HumanSignaturePort = { verify: () => null };
    const refused = execute(doc, 'accept_pid_finding', { ...params, confirmation: { nonce: 'n' } }, ctxOf(deaf));
    expect(refused.error?.code).toBe('PID_HUMAN_GATE');
    expect(refused.document).toBe(doc);
    const agent = execute(doc, 'accept_pid_finding', { ...params, by: 'claude' });
    expect(agent.error?.code).toBe('PID_HUMAN_GATE');
  });

  it('a signed acceptance records the verified signer (not the `by` param), the signature id and the signed payload hash, and spends the signature once', () => {
    const error = errorOf(doc);
    const { port, seen, spent } = recordingPort();
    const params = {
      findingKey: error.findingKey,
      reason: 'partner sheet is drawn later',
      by: 'mallory',
      at: AT,
      confirmation: { nonce: 'n1' },
    };
    const result = execute(doc, 'accept_pid_finding', params, ctxOf(port));
    expect(result.rejected, result.summary).toBeUndefined();
    const stored = getPid(result.document).acceptances?.[error.findingKey];
    expect(stored).toMatchObject({ by: 'alice', code: error.code, severity: 'error', signatureId: 'sig-1', at: AT });
    expect(stored?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen).toHaveLength(1);
    expect(spent.size).toBe(1);
    expect(check(result.document).items.map((item) => item.findingKey)).not.toContain(error.findingKey);
    expect(data<{ status: string }>(result.document, 'check_pid', {}).status).not.toBe('fail');
  });

  it('is bound to the document: the same signature in a copy with another uid does not verify (GATE-UID)', () => {
    const error = errorOf(doc);
    expectBoundToDocument(
      doc,
      (document, confirmation, ctx) =>
        execute(document, 'accept_pid_finding', { findingKey: error.findingKey, reason: 'later', at: AT, confirmation }, ctx),
      'PID_HUMAN_GATE',
    );
  });

  it('refuses an unknown key, an accepted one twice and a warning without `by`, leaving the document unchanged and spending nothing', () => {
    expectRefusal(
      doc,
      'accept_pid_finding',
      { findingKey: 'pid:PID_NOZZLE_UNCONNECTED:nope', reason: 'x', by: 'a', at: AT },
      'PID_FINDING_NOT_FOUND',
      'findingKey',
    );
    const warning = warningOf(doc);
    expectRefusal(doc, 'accept_pid_finding', { findingKey: warning.findingKey, reason: 'x', at: AT }, 'PID_PARAM_INVALID', 'by');
    const accepted = apply(doc, 'accept_pid_finding', { findingKey: warning.findingKey, reason: 'x', by: 'a', at: AT });
    expectRefusal(
      accepted,
      'accept_pid_finding',
      { findingKey: warning.findingKey, reason: 'y', by: 'a', at: AT },
      'PID_PARAM_INVALID',
      'findingKey',
    );
    const { port, seen } = recordingPort();
    const unknown = execute(
      doc,
      'accept_pid_finding',
      { findingKey: 'pid:nothing', reason: 'x', at: AT, confirmation: { nonce: 'n' } },
      ctxOf(port),
    );
    expect(unknown.error?.code).toBe('PID_FINDING_NOT_FOUND');
    expect(seen).toEqual([]);
  });

  it('is pure and survives a history replay (the acceptance is carried, the signature is never run twice)', () => {
    const error = errorOf(doc);
    const snapshot = JSON.stringify(doc);
    const { port, spent } = recordingPort();
    const signed = execute(
      doc,
      'accept_pid_finding',
      { findingKey: error.findingKey, reason: 'later', at: AT, confirmation: { nonce: 'n' } },
      ctxOf(port),
    );
    expect(JSON.stringify(doc)).toBe(snapshot);
    const replayed = execute(signed.document, 'replay_history', {}, ctxOf(port));
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(getPid(replayed.document).acceptances).toEqual(getPid(signed.document).acceptances);
    expect(spent.size).toBe(1);
  });
});

describe('issue_pid_sheet', () => {
  it('draft -> issued_for_review -> issued_for_hazop is open to an agent (reviewRequired stays true, no stamp); one step back to draft is allowed', () => {
    let doc = cleanSheet();
    const review = execute(doc, 'issue_pid_sheet', { sheet: 'PID-009', status: 'issued_for_review', revision: 'A', at: AT });
    expect(review.rejected, review.summary).toBeUndefined();
    expect(review.data).toMatchObject({ status: 'issued_for_review', from: 'draft', revision: 'A', reviewRequired: true });
    doc = review.document;
    expect(Object.values(getPid(doc).sheets)[0]).toMatchObject({ status: 'issued_for_review', revision: 'A' });
    expect(Object.values(getPid(doc).sheets)[0]?.issuedBy).toBeUndefined();
    doc = apply(doc, 'issue_pid_sheet', { sheet: 'PID-009', status: 'issued_for_hazop', revision: 'B', at: AT });
    const back = apply(doc, 'issue_pid_sheet', { sheet: 'PID-009', status: 'draft', revision: 'C', at: AT });
    expect(Object.values(getPid(back).sheets)[0]).toMatchObject({ status: 'draft', revision: 'C' });
  });

  it('issued_for_construction needs a human signature over the act, the content hash and the accepted errors; the stamp holds signer, time, signature id, payload and content hash', () => {
    const doc = cleanSheet();
    const params = { sheet: 'PID-009', status: 'issued_for_construction', revision: '0', at: AT };
    expectRefusal(doc, 'issue_pid_sheet', params, 'PID_HUMAN_GATE', 'confirmation');
    expectRefusal(doc, 'issue_pid_sheet', { ...params, confirmation: true }, 'PID_HUMAN_GATE', 'confirmation');
    const { port, seen, spent } = recordingPort();
    const result = execute(doc, 'issue_pid_sheet', { ...params, confirmation: { nonce: 'n1' } }, ctxOf(port));
    expect(result.rejected, result.summary).toBeUndefined();
    const sheet = Object.values(getPid(result.document).sheets)[0];
    expect(sheet).toMatchObject({ status: 'issued_for_construction', revision: '0' });
    expect(sheet?.issuedBy).toMatchObject({ signer: 'alice', at: AT, signatureId: 'sig-1' });
    expect(sheet?.issuedBy?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sheet?.issuedBy?.contentSha256).toBe((result.data as { contentSha256: string }).contentSha256);
    expect(result.data).toMatchObject({ reviewRequired: false, signer: 'alice', acceptedErrors: [] });
    expect(seen).toHaveLength(1);
    expect(spent.size).toBe(1);
    expect(pidErrors(getPid(result.document))).toEqual([]);
  });

  it('is bound to the document: a copy with another uid refuses the same signature (GATE-UID)', () => {
    expectBoundToDocument(
      cleanSheet(),
      (document, confirmation, ctx) =>
        execute(
          document,
          'issue_pid_sheet',
          { sheet: 'PID-009', status: 'issued_for_construction', revision: '0', at: AT, confirmation },
          ctx,
        ),
      'PID_HUMAN_GATE',
    );
  });

  it('an unaccepted error refuses PID_CHECK_FAILED before the signature is asked for (never spent); a human-accepted error lets the sheet through and is named in the signed payload', () => {
    const doc = feedPump();
    const error = errorOf(doc);
    const { port, seen } = recordingPort();
    const params = { sheet: 'PID-001', status: 'issued_for_construction', revision: '0', at: AT, confirmation: { nonce: 'n1' } };
    const refused = execute(doc, 'issue_pid_sheet', params, ctxOf(port));
    expect(refused.error?.code).toBe('PID_CHECK_FAILED');
    expect(refused.document).toBe(doc);
    expect(seen).toEqual([]);
    let accepted = doc;
    for (const item of check(doc).items.filter((entry) => entry.severity === 'error'))
      accepted = execute(
        accepted,
        'accept_pid_finding',
        { findingKey: item.findingKey, reason: 'known', at: AT, confirmation: { nonce: `a-${item.findingKey}` } },
        ctxOf(recordingPort().port),
      ).document;
    expect(check(accepted).summary.errors).toBe(0);
    const issued = execute(accepted, 'issue_pid_sheet', params, ctxOf(port));
    expect(issued.rejected, issued.summary).toBeUndefined();
    expect((issued.data as { acceptedErrors: string[] }).acceptedErrors).toContain(error.findingKey);
  });

  it('a stamp records the content hash of the sheet: an edit afterwards changes the hash a new stamp would carry (the old stamp stays and is visibly different)', () => {
    const { port } = recordingPort();
    const issued = execute(
      cleanSheet(),
      'issue_pid_sheet',
      { sheet: 'PID-009', status: 'issued_for_construction', revision: '0', at: AT, confirmation: { nonce: 'n' } },
      ctxOf(port),
    );
    const stamped = Object.values(getPid(issued.document).sheets)[0]?.issuedBy?.contentSha256;
    const edited = apply(issued.document, 'add_pid_equipment', { sheet: 'PID-009', class: 'Tank', tag: 'T-900', at: [60, 150] });
    const reissued = execute(edited, 'issue_pid_sheet', { sheet: 'PID-009', status: 'draft', revision: '1', at: AT });
    expect((reissued.data as { contentSha256: string }).contentSha256).not.toBe(stamped);
  });

  it('refuses an unknown sheet and a status that is not a forward step or draft; going back to draft clears the stamp; replay keeps status and stamp', () => {
    const doc = cleanSheet();
    expectRefusal(
      doc,
      'issue_pid_sheet',
      { sheet: 'PID-404', status: 'issued_for_review', revision: 'A', at: AT },
      'PID_SHEET_NOT_FOUND',
      'sheet',
    );
    expectRefusal(doc, 'issue_pid_sheet', { sheet: 'PID-009', status: 'draft', revision: 'A', at: AT }, 'PID_STATUS_TRANSITION', 'status');
    const { port, spent } = recordingPort();
    const issued = execute(
      doc,
      'issue_pid_sheet',
      { sheet: 'PID-009', status: 'issued_for_construction', revision: '0', at: AT, confirmation: { nonce: 'n' } },
      ctxOf(port),
    );
    expectRefusal(
      issued.document,
      'issue_pid_sheet',
      { sheet: 'PID-009', status: 'issued_for_review', revision: 'B', at: AT },
      'PID_STATUS_TRANSITION',
      'status',
    );
    const replayed = execute(issued.document, 'replay_history', {}, ctxOf(port));
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(Object.values(getPid(replayed.document).sheets)[0]).toEqual(Object.values(getPid(issued.document).sheets)[0]);
    expect(spent.size).toBe(1);
    const reopened = apply(issued.document, 'issue_pid_sheet', { sheet: 'PID-009', status: 'draft', revision: '1', at: AT });
    expect(Object.values(getPid(reopened).sheets)[0]?.issuedBy).toBeUndefined();
  });

  it('is pure: the input document is not modified', () => {
    const doc = cleanSheet();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'issue_pid_sheet', { sheet: 'PID-009', status: 'issued_for_review', revision: 'A', at: AT });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('load validation of the stamps', () => {
  it('rejects a malformed acceptance or issue stamp with a path', () => {
    const doc = apply(feedPump(), 'accept_pid_finding', { findingKey: warningOf(feedPump()).findingKey, reason: 'x', by: 'a', at: AT });
    const raw = JSON.parse(JSON.stringify(getPid(doc))) as Record<string, Record<string, Record<string, unknown>>>;
    const key = Object.keys(raw['acceptances'] as object)[0] as string;
    (raw['acceptances'] as Record<string, Record<string, unknown>>)[key]!['severity'] = 'fatal';
    expect(pidErrors(raw)).toEqual([expect.stringContaining('severity must be error, warning or info')]);
    (raw['acceptances'] as Record<string, Record<string, unknown>>)[key]!['severity'] = 'warning';
    (raw['acceptances'] as Record<string, Record<string, unknown>>)[key]!['signatureId'] = '';
    expect(pidErrors(raw)).toEqual([expect.stringContaining('signatureId must be a non-empty string')]);
  });
});
