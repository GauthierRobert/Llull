import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { APPROVALS, T, inReview, inWork, released, releasedB, reviewWithEco } from './fixtures';
import { agentContext, loadSample, readValidation, run } from './scenarioRunner';

const code = (doc: CadDocument, command: string, params: unknown): string | undefined => run(doc, command, params).error?.code;

describe('S2 lifecycle guards (VC-PLM-02, 03, 08, 09, 25)', () => {
  it('S2-01: release from in_work is refused with the table text', () => {
    const doc = inWork();
    const result = run(doc, 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' });
    expect(result.summary).toBe('release_item rejected: LL-2001 rev A is in_work; submit_for_review first');
    expect(result.error?.code).toBe('PLM_STATE_TRANSITION');
    expect(result.error?.remediation).not.toBe('');
    expect(result.document).toBe(doc);
  });

  it('S2-02: the checker must differ from the author', () => {
    const doc = reviewWithEco();
    const result = run(doc, 'release_item', {
      changeOrder: 'ECO-0100',
      approvals: [
        { role: 'design-authority', userId: 'u-1' },
        { role: 'checker', userId: 'u-1' },
      ],
      at: T,
      by: 'u-1',
    });
    expect(result.summary).toContain('checker must differ from the author');
    expect(result.error?.code).toBe('PLM_CHECKER_IS_AUTHOR');
    expect(result.document).toBe(doc);
  });

  it('S2-03: reject_review returns to in_work, drops approvals and unfreezes the definition', () => {
    let doc = run(reviewWithEco(), 'record_approval', { role: 'checker', userId: 'u-2' }).document;
    expect(code(doc, 'add_box', { size: [1, 1, 1] })).toBe('PLM_LOCKED');
    expect(run(doc, 'add_box', { size: [1, 1, 1] }).summary).toContain('reject_review first');
    doc = run(doc, 'reject_review', { comment: 'missing edge break note', at: T, by: 'u-2' }).document;
    expect(doc.plm?.item.revisions['A']?.state).toBe('in_work');
    expect(doc.plm?.item.revisions['A']?.approvals).toEqual([]);
    expect(run(doc, 'add_box', { size: [1, 1, 1] }).rejected).toBeUndefined();
    expect(code(inReview(), 'reject_review', { comment: '  ' })).toBe('PLM_PARAM_INVALID');
    expect(code(inWork(), 'reject_review', { comment: 'x' })).toBe('PLM_STATE_TRANSITION');
  });

  it('S2-04/05: a released definition is locked but view state stays editable', () => {
    const doc = released();
    const move = run(doc, 'move_entities', { ids: ['box-2.1'], delta: [1, 0, 0] });
    expect(move.summary).toMatch(/rejected: LL-2001 rev A is released; open an ECO and revise_item/);
    expect(move.error?.code).toBe('PLM_LOCKED');
    expect(move.document).toBe(doc);
    expect(run(doc, 'set_camera', { target: [0, 0, 0] }).rejected).toBeUndefined();
    expect(run(doc, 'set_camera', { target: [0, 0, 0] }).document.camera.target).toEqual([0, 0, 0]);
  });

  it('S2-06: revise without an open ECO is refused', () => {
    const result = run(released(), 'revise_item', { at: T, by: 'u-1' });
    expect(result.summary).toContain('a released revision can only be revised under an open change order (policy.requireChangeOrder)');
    expect(result.error?.code).toBe('PLM_ECO_REQUIRED');
  });

  it('S2-07/08: obsolescence keeps the hash and drops the revision from effectivity resolution', () => {
    const doc = releasedB();
    expect(run(doc, 'set_lifecycle_state', { revision: 'A', state: 'in_work', reason: 'x' }).summary).toContain('invalid params');
    expect(code(doc, 'set_lifecycle_state', { revision: 'B', state: 'obsolete', reason: 'replaced' })).toBe('PLM_ECO_REQUIRED');
    const withEco = run(doc, 'create_change_order', {
      id: 'ECO-0140',
      classification: 'major',
      classificationJustification: 'withdrawn',
      at: T,
      by: 'u-1',
    }).document;
    const obsolete = run(withEco, 'set_lifecycle_state', {
      revision: 'B',
      state: 'obsolete',
      reason: 'part replaced by LL-2002',
      changeOrder: 'ECO-0140',
      at: T,
      by: 'u-1',
    }).document;
    expect(obsolete.plm?.item.revisions['B']?.state).toBe('obsolete');
    expect(obsolete.plm?.item.revisions['B']?.contentHash).toBe(doc.plm?.item.revisions['B']?.contentHash);
    expect((run(obsolete, 'resolve_effectivity', { kind: 'serial', unit: 99 }).data as { revision: string | null }).revision).toBeNull();
    expect(code(obsolete, 'set_lifecycle_state', { revision: 'B', state: 'cancelled', reason: 'x' })).toBe('PLM_STATE_TRANSITION');
    expect(code(obsolete, 'set_lifecycle_state', { revision: 'Z', state: 'obsolete', reason: 'x' })).toBe('PLM_REVISION_UNKNOWN');
    expect(code(doc, 'set_lifecycle_state', { revision: 'A', state: 'obsolete', reason: ' ' })).toBe('PLM_PARAM_INVALID');
    expect(
      run(doc, 'set_lifecycle_state', { revision: 'A', state: 'obsolete', reason: 'old' }).document.plm?.item.revisions['A']?.state,
    ).toBe('obsolete');
  });

  it('an in_review revision cannot be cancelled and an in_work one can', () => {
    expect(run(inReview(), 'set_lifecycle_state', { revision: 'A', state: 'cancelled', reason: 'x' }).summary).toContain(
      'reject_review first',
    );
    const cancelled = run(inWork(), 'set_lifecycle_state', { revision: 'A', state: 'cancelled', reason: 'dropped' }).document;
    expect(cancelled.plm?.item.revisions['A']?.state).toBe('cancelled');
    expect(run(cancelled, 'add_box', { size: [1, 1, 1] }).rejected).toBeUndefined();
  });

  it('S2-10: a tampered file loads with a mismatch warning, stays locked, and can be restored', () => {
    const doc = released();
    const text = JSON.stringify({ format: 'llull-document', version: 3, document: doc });
    const tampered = text.replace('"expression":"4"', '"expression":"9"');
    expect(tampered).not.toBe(text);
    const loaded = run(createEmptyDocument(), 'load_document', { json: tampered });
    expect(loaded.summary).toContain('release A content hash mismatch');
    const status = run(loaded.document, 'plm_status', {}).data as { integrity: Record<string, string> };
    expect(status.integrity['A']).toBe('mismatch');
    expect(code(loaded.document, 'set_parameter', { name: 't', expression: '4' })).toBe('PLM_LOCKED');
    const verify = run(loaded.document, 'verify_release', { revision: 'A' }).data as {
      contentHashMatches: boolean;
      liveDefinitionMatches: boolean;
    };
    expect(verify).toMatchObject({ contentHashMatches: true, liveDefinitionMatches: false });
    const restored = run(loaded.document, 'restore_revision_snapshot', { revision: 'A' });
    expect(restored.rejected, restored.summary).toBeUndefined();
    expect((run(restored.document, 'plm_status', {}).data as { integrity: Record<string, string> }).integrity['A']).toBe('ok');
    expect(restored.document.parameters['t']?.expression).toBe('4');
    expect(code(restored.document, 'restore_revision_snapshot', { revision: 'A' })).toBe('PLM_PARAM_INVALID');
  });

  it('S2-10b: a tampered snapshot is reported on load as well', () => {
    const doc = released();
    const text = JSON.stringify({ format: 'llull-document', version: 3, document: doc }).replace(
      '\\"expression\\":\\"4\\"',
      '\\"expression\\":\\"9\\"',
    );
    expect(run(createEmptyDocument(), 'load_document', { json: text }).summary).toContain('content hash mismatch');
  });

  it('S2-11: verify_release of an untouched revision, and refusal for unreleased ones', () => {
    const doc = releasedB();
    const verified = run(doc, 'verify_release', { revision: 'A' });
    expect(verified.data).toMatchObject({
      contentHashMatches: true,
      reconstructedFrom: 'release snapshot A',
      signaturesValid: 'n/a (none attached)',
    });
    expect(verified.document).toBe(doc);
    expect(code(inWork(), 'verify_release', { revision: 'A' })).toBe('PLM_NOT_RELEASED');
    expect(code(doc, 'verify_release', { revision: 'Q' })).toBe('PLM_REVISION_UNKNOWN');
  });

  it('S2-13: an agent cannot release even with every approval recorded; a human can', () => {
    let doc = reviewWithEco();
    for (const approval of APPROVALS) doc = run(doc, 'record_approval', approval).document;
    const agent = run(doc, 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-agent' }, agentContext());
    expect(agent.error?.code).toBe('PLM_HUMAN_GATE');
    expect(agent.summary).toContain('human');
    expect(agent.document).toBe(doc);
    expect(run(doc, 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document.plm?.item.revisions['A']?.state).toBe(
      'released',
    );
  });

  it('PLM-only commands are not blocked by the lock, and a removed PLM record is refused', () => {
    const doc = released();
    expect(run(doc, 'set_item_marking', { regime: 'none', decidedBy: 'u-3' }).rejected).toBeUndefined();
    expect(code(doc, 'create_change_request', { title: 'x', reason: 'y' })).toBeUndefined();
    const { plm: _plm, ...rest } = doc;
    void _plm;
    expect(
      run(doc, 'load_document', { json: JSON.stringify({ format: 'llull-document', version: 3, document: rest }) }).document.plm,
    ).toBeUndefined();
  });

  it('revise then edit in one build_project is allowed; editing the locked revision is not', () => {
    const doc = run(released(), 'create_change_order', {
      id: 'ECO-0200',
      classification: 'minor',
      classificationJustification: 'j',
      at: T,
      by: 'u-1',
    }).document;
    const plan = run(doc, 'build_project', {
      actions: [
        { command: 'revise_item', params: { changeOrder: 'ECO-0200', at: T, by: 'u-1' } },
        { command: 'set_parameter', params: { name: 't', expression: '6' } },
      ],
    });
    expect(plan.document.plm?.item.currentRevision).toBe('B');
    expect(plan.document.parameters['t']?.expression).toBe('6');
    expect(plan.document.plm?.item.revisions['A']?.state).toBe('released');
    const blocked = run(doc, 'build_project', { actions: [{ command: 'set_parameter', params: { name: 't', expression: '6' } }] });
    expect(blocked.document.parameters['t']?.expression).toBe('4');
  });

  it('a hand-edited state jump fails validation on load (TR-PLM-12)', () => {
    const doc = released();
    const revision = doc.plm?.item.revisions['A'];
    const forged = {
      ...doc,
      plm: {
        ...doc.plm,
        item: {
          ...doc.plm?.item,
          revisions: {
            A: {
              ...revision,
              stateHistory: [
                { from: null, to: 'in_work' },
                { from: 'in_work', to: 'released' },
              ],
            },
          },
        },
      },
    };
    const result = run(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({ format: 'llull-document', version: 3, document: forged }),
    });
    expect(result.summary).toContain('transition the lifecycle does not allow');
    expect(result.document.plm).toBeUndefined();
  });

  it('keeps the sample document untouched and approvals structure valid', () => {
    expect(APPROVALS).toHaveLength(2);
    expect(readValidation('sample_document.json')).toContain('"entities"');
    expect(loadSample().plm).toBeUndefined();
  });
});
