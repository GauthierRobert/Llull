/** Attack tests of the human gate (AF-34, TR-PLM-16): a human-only act needs a signature over THAT act; no label, flag or param clears it. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { actPayload } from '@plm/gate';
import { APPROVALS, T, approveAll, inReview, inWork, released, reviewWithEco } from './fixtures';
import { agentContext, confirmed, humanContext, loadSample, run, runRaw } from './scenarioRunner';

const code = (result: ReturnType<typeof run>): string | undefined => result.error?.code;

describe('an agent cannot clear any human-only plm act (no port, no key)', () => {
  const acts: [string, (doc: CadDocument) => unknown, string][] = [
    ['record_approval', () => ({ role: 'checker', userId: 'u-2' }), 'in_review'],
    ['release_item', () => ({ changeOrder: 'ECO-0100', at: T, by: 'u-agent' }), 'eco'],
    ['set_item_marking', () => ({ regime: 'none', decidedBy: 'u-3' }), 'in_work'],
    ['create_change_order', () => ({ classification: 'minor', classificationJustification: 'j' }), 'released'],
    ['classify_change_order', () => ({ id: 'ECO-5', classification: 'minor', justification: 'j' }), 'draft'],
    ['set_change_state', () => ({ id: 'ECO-5', state: 'cancelled', reason: 'r' }), 'draft'],
    ['set_lifecycle_state', () => ({ revision: 'A', state: 'obsolete', reason: 'r', changeOrder: 'ECO-5' }), 'draft'],
    [
      'attach_release_package',
      (doc) => ({ revision: 'A', manifestSha256: 'a'.repeat(64), documentContentHash: doc.plm?.item.revisions['A']?.contentHash ?? '' }),
      'released',
    ],
    ['set_item_identity', () => ({ partNumber: 'LL-9', name: 'n', itemType: 'part', policy: { humanSignatureRequired: false } }), 'sample'],
  ];
  const stage = (name: string): CadDocument => {
    switch (name) {
      case 'in_review':
        return inReview();
      case 'eco':
        return approveAll(reviewWithEco());
      case 'in_work':
        return inWork();
      case 'released':
        return released();
      case 'draft':
        return run(released(), 'create_change_order', { id: 'ECO-5' }).document;
      default:
        return loadSample();
    }
  };

  it.each(acts)('%s is refused with PLM_HUMAN_GATE and leaves the document unchanged', (command, params, at) => {
    const doc = stage(at);
    for (const ctx of [
      agentContext(),
      humanContext({ humanSignature: null }),
      { ...agentContext(), caller: { kind: 'human' } } as ExecutionContext,
    ]) {
      const result = runRaw(doc, command, params(doc), ctx);
      expect(code(result), `${command}: ${result.summary}`).toBe('PLM_HUMAN_GATE');
      expect(result.document).toBe(doc);
    }
  });

  it('a bare true is not even a valid confirmation', () => {
    const doc = approveAll(reviewWithEco());
    expect(runRaw(doc, 'release_item', { changeOrder: 'ECO-0100', confirmation: true }).document).toBe(doc);
  });

  it('an unsigned object, a forged user and a missing signature are all refused', () => {
    const doc = approveAll(reviewWithEco());
    const params = { changeOrder: 'ECO-0100', at: T, by: 'u-1' };
    for (const confirmation of [
      {},
      { alg: 'Ed25519', as: 'u-1', nonce: 'n1234567' },
      { as: 'u-1', signature: 'not-the-payload', nonce: 'n1234567' },
    ]) {
      const result = runRaw(doc, 'release_item', { ...params, confirmation });
      expect(code(result)).toBe('PLM_HUMAN_GATE');
      expect(result.document).toBe(doc);
    }
  });

  it('the signature-required policy cannot be switched off without a signature', () => {
    const doc = run(loadSample(), 'set_item_identity', { partNumber: 'LL-1', name: 'n', itemType: 'part' }).document;
    expect(doc.plm?.policy.humanSignatureRequired).toBe(true);
    const result = runRaw(doc, 'set_item_identity', {
      partNumber: 'LL-1',
      name: 'n',
      itemType: 'part',
      policy: { humanSignatureRequired: false },
    });
    expect(code(result)).toBe('PLM_HUMAN_GATE');
    expect(result.document).toBe(doc);
  });
});

describe('a confirmation is bound to its act, its params and the document state', () => {
  it('a signature for another act, other params or another state does not verify', () => {
    const doc = approveAll(reviewWithEco());
    const params = { changeOrder: 'ECO-0100', at: T, by: 'u-1' };
    const forOtherCommand = confirmed(doc, 'record_approval', { role: 'checker', userId: 'u-2' }, 'u-1').confirmation;
    expect(code(runRaw(doc, 'release_item', { ...params, confirmation: forOtherCommand }))).toBe('PLM_HUMAN_GATE');
    const forOtherParams = confirmed(doc, 'release_item', { ...params, changeOrder: 'ECO-9999' }, 'u-1').confirmation;
    expect(code(runRaw(doc, 'release_item', { ...params, confirmation: forOtherParams }))).toBe('PLM_HUMAN_GATE');
    const signedNow = confirmed(doc, 'release_item', params, 'u-1');
    const later = run(doc, 'set_item_marking', { regime: 'none', decidedBy: 'u-3' }).document;
    expect(code(runRaw(later, 'release_item', signedNow))).toBe('PLM_HUMAN_GATE');
    expect(runRaw(doc, 'release_item', signedNow).document.plm?.item.revisions['A']?.state).toBe('released');
  });

  it('a release signature binds the document definition: changing the model after signing invalidates it', () => {
    const doc = approveAll(reviewWithEco());
    const params = { changeOrder: 'ECO-0100', at: T, by: 'u-1' };
    const signedNow = confirmed(doc, 'release_item', params, 'u-1');
    const changed = { ...doc, units: doc.units === 'in' ? 'mm' : 'in' } as CadDocument;
    expect(code(runRaw(changed, 'release_item', signedNow))).toBe('PLM_HUMAN_GATE');
    expect(runRaw(doc, 'release_item', signedNow).document.plm?.item.revisions['A']?.state).toBe('released');
    // the payload query exposes the content hash it binds
    const data = run(doc, 'plm_act_payload', { command: 'release_item', params, nonce: 'abcdefgh' }).data as {
      details: { contentHash?: string };
    };
    expect(data.details.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a used confirmation cannot be replayed: the PLM state it bound has moved on', () => {
    const doc = inReview();
    const signed = confirmed(doc, 'record_approval', { role: 'checker' }, 'u-2');
    const once = runRaw(doc, 'record_approval', signed);
    expect(once.document.plm?.item.revisions['A']?.approvals).toHaveLength(1);
    expect(code(runRaw(once.document, 'record_approval', signed))).toBe('PLM_HUMAN_GATE');
  });

  it('plm_act_payload returns exactly the hash a verified confirmation must cover, and only for human-only commands', () => {
    const doc = approveAll(reviewWithEco());
    const params = { changeOrder: 'ECO-0100' };
    const data = run(doc, 'plm_act_payload', { command: 'release_item', params, nonce: 'abcdefgh' }).data as { payloadSha256: string };
    expect(data.payloadSha256).toBe(actPayload(doc, 'release_item', params, 'abcdefgh'));
    expect(run(doc, 'plm_act_payload', { command: 'add_box', params: {}, nonce: 'abcdefgh' }).rejected).toBe(true);
    expect(run(doc, 'plm_act_payload', { command: 'release_item', params, nonce: 'short' }).rejected).toBe(true);
  });
});

describe('the identity of a human act is the signer, never a name in the params', () => {
  it('release, approval and marking are recorded under the signer of the confirmation', () => {
    const doc = reviewWithEco();
    const approved = runRaw(doc, 'record_approval', confirmed(doc, 'record_approval', { role: 'checker', userId: 'u-boss' }, 'u-2'));
    expect(approved.document.plm?.item.revisions['A']?.approvals[0]?.userId).toBe('u-2');
    const marked = runRaw(doc, 'set_item_marking', confirmed(doc, 'set_item_marking', { regime: 'none', decidedBy: 'u-boss' }, 'u-3'));
    expect(marked.document.plm?.item.marking.decidedBy).toBe('u-3');
    const ready = approveAll(doc);
    const params = { changeOrder: 'ECO-0100', at: T, by: 'u-boss' };
    const release = runRaw(ready, 'release_item', confirmed(ready, 'release_item', params, 'u-7'));
    expect(release.document.plm?.item.revisions['A']?.releasedBy).toBe('u-7');
    expect(APPROVALS).toHaveLength(2);
  });

  it('an agent that cannot approve cannot release by calling record_approval for others: each approval needs its own approver signature', () => {
    const doc = inReview();
    const signedAsChecker = confirmed(doc, 'record_approval', { role: 'design-authority' }, 'u-2');
    const result = runRaw(doc, 'record_approval', signedAsChecker);
    expect(result.document.plm?.item.revisions['A']?.approvals).toEqual([{ role: 'design-authority', userId: 'u-2' }]);
  });
});
