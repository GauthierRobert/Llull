/** The human gate of the review model is bound to the issue, single use, re-verified by check_review, and also guards deletion (cad-reviewer round). */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { reviewProblems } from '@core/commands/persistence/reviewValidation';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ReviewIssue } from '@core/model/review';
import { confirmationOver, deleteIssue, humanCtx, ledgerPort } from './humanActs';

/** A resolved issue iss-2 in a document; `title` and `entity` change the issue content (same id, same history length in every variant). */
function documentWith(title: string, size = 10): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [size, size, size] }).document;
  doc = execute(doc, 'save_viewpoint', { name: 'v', fromDocumentCamera: true }).document;
  doc = execute(doc, 'create_review_issue', { title, viewpointIds: ['vp-1'], entityIds: [doc.order[0]] }).document;
  return execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document;
}

const close = { issueId: 'iss-2', status: 'closed', reason: 'accept' };
const closeParams = (doc: CadDocument, as = 'grace', nonce = 'n-1'): Record<string, unknown> => ({
  ...close,
  confirmation: confirmationOver(doc, close, as, nonce),
});
const withIssue = (doc: CadDocument, patch: Partial<ReviewIssue>): CadDocument => {
  const review = doc.review!;
  return { ...doc, review: { ...review, issues: { ...review.issues, 'iss-2': { ...review.issues['iss-2']!, ...patch } } } };
};
const rows = (doc: CadDocument, ctx?: ReturnType<typeof humanCtx>): { status: string; issues: { code: string; ids: string[] }[] } =>
  execute(doc, 'check_review', {}, ctx).data as never;

describe('a signature is bound to the issue, not just its id', () => {
  it('a signature for iss-2 of document A is refused on a different iss-2 of document B, and passes on A', () => {
    const a = documentWith('Nozzle faces the walkway');
    const b = documentWith('Something else entirely');
    expect(a.review?.issues['iss-2']?.history).toHaveLength(1);
    expect(b.review?.issues['iss-2']?.history).toHaveLength(1);
    const forA = closeParams(a);
    expect(execute(b, 'set_issue_status', forA, humanCtx()).error?.code).toBe('VIS_HUMAN_GATE');
    expect(execute(a, 'set_issue_status', forA, humanCtx()).error).toBeUndefined();
  });

  it('a different entity set or viewpoint list also changes what is signed', () => {
    const a = documentWith('t');
    const moved = withIssue(a, { entityIds: [] });
    expect(execute(moved, 'set_issue_status', closeParams(a), humanCtx()).error?.code).toBe('VIS_HUMAN_GATE');
  });

  it('a signature is single use on a ledger host: replaying it after undo (same state, same payload) is refused', () => {
    const doc = documentWith('t');
    const ctx = humanCtx(ledgerPort());
    const params = closeParams(doc);
    const first = execute(doc, 'set_issue_status', params, ctx);
    expect(first.error).toBeUndefined();
    const replay = execute(doc, 'set_issue_status', params, ctx);
    expect(replay.error?.code).toBe('VIS_HUMAN_GATE');
    expect(replay.document).toBe(doc);
    expect(execute(doc, 'set_issue_status', params, humanCtx(ledgerPort())).error).toBeUndefined();
  });

  it('a valid signature on a non-gated move is recorded as human and spent', () => {
    const doc = documentWith('t');
    const ctx = humanCtx();
    const params = { issueId: 'iss-2', status: 'in_progress', reason: 'rework' };
    const confirmation = confirmationOver(doc, params);
    const moved = execute(doc, 'set_issue_status', { ...params, confirmation }, ctx);
    expect(moved.document.review?.issues['iss-2']?.history.at(-1)).toMatchObject({ by: 'human', signer: 'grace', proof: confirmation });
    expect(execute(doc, 'set_issue_status', { ...params, confirmation }, ctx).error?.code).toBe('VIS_HUMAN_GATE');
  });
});

describe('check_review re-verifies every human history entry', () => {
  const closed = (): CadDocument => {
    const doc = documentWith('t');
    return execute(doc, 'set_issue_status', closeParams(doc), humanCtx()).document;
  };

  it('passes a genuinely signed close when the host can verify, and says it cannot verify without a port', () => {
    const doc = closed();
    expect(rows(doc, humanCtx())).toMatchObject({ status: 'pass', issues: [] });
    const unverified = rows(doc);
    expect(unverified.status).toBe('warn');
    expect(unverified.issues).toEqual([expect.objectContaining({ code: 'VIS_SIGNATURE_UNVERIFIED', ids: ['iss-2'] })]);
    expect(rows(doc, { ...defaultContext(), humanSignature: null }).issues.map((row) => row.code)).toEqual(['VIS_SIGNATURE_UNVERIFIED']);
  });

  it('fails a forged human entry (made up signatureId, no real signature)', () => {
    const doc = documentWith('t');
    const history = [...doc.review!.issues['iss-2']!.history];
    const forged = withIssue(doc, {
      status: 'closed',
      history: [
        ...history,
        {
          status: 'closed',
          by: 'human',
          reason: 'accept',
          signatureId: 'k:abc',
          signer: 'grace',
          proof: { nonce: 'n-1', signature: 'forged', keyId: 'grace' },
        },
      ],
    });
    const result = rows(forged, humanCtx());
    expect(result.status).toBe('fail');
    expect(result.issues.find((row) => row.code === 'VIS_HUMAN_GATE')?.ids).toEqual(['iss-2']);
    const noNonce = withIssue(doc, {
      status: 'closed',
      history: [
        ...history,
        { status: 'closed', by: 'human', reason: 'accept', signatureId: 'k:abc', signer: 'grace', proof: { signature: 'x' } },
      ],
    });
    expect(rows(noNonce, humanCtx()).status).toBe('fail');
  });

  it('fails a real signature moved onto an issue it was not made for', () => {
    const a = closed();
    const stolen = a.review!.issues['iss-2']!.history.at(-1)!;
    const b = documentWith('Something else entirely');
    const transplanted = withIssue(b, { status: 'closed', history: [...b.review!.issues['iss-2']!.history, stolen] });
    expect(rows(transplanted, humanCtx()).status).toBe('fail');
  });
});

describe('load validation of the history chain', () => {
  const review = (): Record<string, unknown> => JSON.parse(JSON.stringify(documentWith('t').review)) as Record<string, unknown>;
  const problems = (history: unknown, status: string): string => {
    const base = review() as { issues: Record<string, Record<string, unknown>> };
    return reviewProblems({ ...base, issues: { 'iss-2': { ...base.issues['iss-2'], status, history } } }).join(' | ');
  };

  it('accepts a legal chain ending at the status', () => {
    expect(problems([{ status: 'in_progress', by: 'agent', reason: 'x' }], 'in_progress')).toBe('');
  });

  it('refuses an illegal move, a status that is not where the history ends, and a human entry without its proof', () => {
    expect(problems([{ status: 'open', by: 'agent', reason: 'x' }], 'open')).toContain('illegal move open -> open');
    expect(
      problems(
        [
          { status: 'closed', by: 'agent', reason: 'x' },
          { status: 'resolved', by: 'agent', reason: 'y' },
        ],
        'resolved',
      ),
    ).toContain('illegal move closed -> resolved');
    expect(problems([{ status: 'resolved', by: 'agent', reason: 'x' }], 'closed')).toContain('is not where the history ends');
    expect(problems([], 'resolved')).toContain('is not where the history ends');
    expect(problems([{ status: 'closed', by: 'human', reason: 'x', signatureId: 'k:abc', signer: 'grace' }], 'closed')).toContain(
      'carries signatureId, signer and proof',
    );
    expect(problems([{ status: 'closed' }], 'closed')).toContain('history entries are');
  });
});

describe('delete_review_issue is a human act', () => {
  it('refuses an agent whatever it passes, and leaves the document alone', () => {
    const doc = documentWith('t');
    const forged = { alg: 'Ed25519', keyId: 'grace', nonce: 'd-1', signature: 'forged' };
    const other = documentWith('other');
    for (const confirmation of [
      undefined,
      {},
      forged,
      confirmationOver(other, { issueId: 'iss-2', act: 'delete_review_issue' }, 'grace', 'd-1'),
    ]) {
      for (const ctx of [undefined, humanCtx(), { ...defaultContext(), humanSignature: null }]) {
        const result = execute(doc, 'delete_review_issue', { id: 'iss-2', ...(confirmation === undefined ? {} : { confirmation }) }, ctx);
        expect(result.error?.code).toBe('VIS_HUMAN_GATE');
        expect(result.document).toBe(doc);
      }
    }
  });

  it('deletes with a signature over this issue, including a human-closed issue, once only', () => {
    const doc = documentWith('t');
    const ctx = humanCtx();
    const deleted = deleteIssue(doc, 'iss-2', ctx);
    expect(deleted.error).toBeUndefined();
    expect(deleted.affected).toEqual(['iss-2']);
    expect(deleted.document.review?.issues).toEqual({});
    expect(deleteIssue(doc, 'iss-2', ctx).error?.code).toBe('VIS_HUMAN_GATE');
    const closedDoc = execute(doc, 'set_issue_status', closeParams(doc), humanCtx()).document;
    expect(deleteIssue(closedDoc, 'iss-2').document.review?.issues).toEqual({});
    expect(execute(closedDoc, 'delete_review_issue', { id: 'iss-2' }).error?.code).toBe('VIS_HUMAN_GATE');
  });

  it('review_act_payload for deletion needs only the nonce; a status payload needs status and reason', () => {
    const doc = documentWith('t');
    const del = execute(doc, 'review_act_payload', { issueId: 'iss-2', act: 'delete_review_issue', nonce: 'n' });
    expect(del.data).toMatchObject({ act: 'review:delete_review_issue', from: 'resolved' });
    const bad = execute(doc, 'review_act_payload', { issueId: 'iss-2', nonce: 'n' });
    expect(bad.error?.code).toBe('VIS_ISSUE_STATUS_INVALID');
  });
});

describe('apply_viewpoint on an orthographic viewpoint', () => {
  it('warns that the projection and roll are not kept', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'save_viewpoint', {
      name: 'plan',
      camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 40 },
    }).document;
    const result = execute(doc, 'apply_viewpoint', { id: 'vp-1' });
    expect((result.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['VIS_VIEWPOINT_APPROXIMATED']);
  });
});

describe('a revoked signer key and the stored proof', () => {
  const signedClose = (): CadDocument => {
    const doc = documentWith('t');
    return execute(doc, 'set_issue_status', closeParams(doc), humanCtx()).document;
  };

  it('reports a genuine signature by a key that is no longer trusted as VIS_SIGNER_REVOKED (warn), not as tampering', () => {
    const doc = signedClose();
    const revoked = rows(doc, humanCtx(ledgerPort('untrusted')));
    expect(revoked.status).toBe('warn');
    expect(revoked.issues.map((row) => [row.code, row.ids])).toEqual([['VIS_SIGNER_REVOKED', ['iss-2']]]);
  });

  it('still fails a forged signature when the key is untrusted (a forger cannot pass for a revoked signer)', () => {
    const doc = documentWith('t');
    const forged = withIssue(doc, {
      status: 'closed',
      history: [
        ...doc.review!.issues['iss-2']!.history,
        {
          status: 'closed',
          by: 'human',
          reason: 'accept',
          signatureId: 'k:abc',
          signer: 'grace',
          proof: { keyId: 'grace', nonce: 'n-1', signature: 'forged' },
        },
      ],
    });
    const result = rows(forged, humanCtx(ledgerPort('untrusted')));
    expect(result.status).toBe('fail');
    expect(result.issues.map((row) => row.code)).toEqual(['VIS_HUMAN_GATE']);
  });

  it('stores only { alg, keyId, publicKey, signature, nonce } of the confirmation', () => {
    const doc = signedClose();
    const proof = doc.review!.issues['iss-2']!.history.at(-1)!.proof!;
    expect(Object.keys(proof).sort()).toEqual(['alg', 'keyId', 'nonce', 'publicKey', 'signature']);
  });

  it('refuses a confirmation with extra fields or oversized values, leaving the document alone', () => {
    const doc = documentWith('t');
    const good = confirmationOver(doc, close);
    for (const confirmation of [
      { ...good, note: 'x' },
      { ...good, keyId: 'g'.repeat(300) },
      { ...good, nonce: 5 },
    ]) {
      const result = execute(doc, 'set_issue_status', { ...close, confirmation }, humanCtx());
      expect(result.error?.code).toBe('VIS_HUMAN_GATE');
      expect(result.document).toBe(doc);
    }
  });

  it('refuses a larger proof at load', () => {
    const base = JSON.parse(JSON.stringify(signedClose().review)) as {
      issues: Record<string, { history: { proof: Record<string, unknown> }[] }>;
    };
    const entry = base.issues['iss-2']!.history.at(-1)!;
    entry.proof['extra'] = 'x';
    expect(reviewProblems(base).join()).toContain('a history proof holds only');
  });
});
