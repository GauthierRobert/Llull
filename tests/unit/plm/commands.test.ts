import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { APPROVALS, T, inReview, inWork, released, releasedB, reviewWithEco } from './fixtures';
import { agentContext, loadSample, run } from './scenarioRunner';

const code = (doc: CadDocument, command: string, params: unknown): string | undefined => run(doc, command, params).error?.code;
const data = <D>(doc: CadDocument, command: string, params: unknown): D => run(doc, command, params).data as D;

describe('identity and scheme (VC-PLM-01, 04, 25)', () => {
  const identity = { partNumber: 'LL-1', name: 'Bracket', itemType: 'part' };

  it('creates revision A in_work at iteration 1 and does not touch the history', () => {
    const doc = loadSample();
    const result = run(doc, 'set_item_identity', identity);
    expect(result.document.plm?.item.revisions['A']).toMatchObject({ state: 'in_work', iterations: [{ n: 1 }] });
    expect(result.document.plm?.item.marking.regime).toBe('undetermined');
    expect(result.document.featureHistory).toBe(doc.featureHistory);
    expect(result.document.plm?.policy).toMatchObject({
      requireChangeOrder: true,
      humanSignatureRequired: true,
      requiredApprovalRoles: ['design-authority', 'checker'],
    });
    expect(result.affected).toEqual([]);
  });

  it('revision labels are file-name and ref safe: path-like or lowercase custom labels are refused, and a forged file with such a key fails validation', () => {
    for (const labels of [['../X'], ['A/B'], ['a'], ['A.1'], ['X'.repeat(17)], ['OK', 'OK']])
      expect(
        code(loadSample(), 'set_item_identity', { ...identity, revisionScheme: 'custom:x', customLabels: labels }),
        labels.join(),
      ).toBe('PLM_SCHEME_INVALID');
    const doc = inWork();
    const revision = doc.plm?.item.revisions['A'];
    const forged = {
      ...doc,
      plm: {
        ...doc.plm,
        item: { ...doc.plm?.item, currentRevision: '../x', revisionOrder: ['../x'], revisions: { '../x': { ...revision, label: '../x' } } },
      },
    };
    const loaded = run(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({ format: 'llull-document', version: 3, document: forged }),
    });
    expect(loaded.summary).toContain('must be 1-16 characters');
    expect(loaded.document.plm).toBeUndefined();
  });

  it('is pure and may rename the item before review (marking is kept)', () => {
    const doc = inWork();
    const before = JSON.stringify(doc);
    const marked = run(doc, 'set_item_marking', { regime: 'none', decidedBy: 'u-3' }).document;
    const renamed = run(marked, 'set_item_identity', { ...identity, revisionScheme: 'numeric-2' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(renamed.document.plm?.item).toMatchObject({ partNumber: 'LL-1', currentRevision: '01', marking: { regime: 'none' } });
  });

  it('refuses bad part numbers, schemes and frozen identities', () => {
    expect(code(loadSample(), 'set_item_identity', { ...identity, partNumber: 'bad pn!' })).toBe('PLM_PN_INVALID');
    expect(code(loadSample(), 'set_item_identity', { ...identity, revisionScheme: 'roman' })).toBe('PLM_SCHEME_INVALID');
    expect(code(loadSample(), 'set_item_identity', { ...identity, revisionScheme: 'custom:x' })).toBe('PLM_SCHEME_INVALID');
    expect(
      run(loadSample(), 'set_item_identity', { ...identity, revisionScheme: 'custom:x', customLabels: ['X1'] }).document.plm?.item
        .currentRevision,
    ).toBe('X1');
    expect(code(inReview(), 'set_item_identity', identity)).toBe('PLM_IDENTITY_FROZEN');
    expect(code(released(), 'set_item_identity', identity)).toBe('PLM_IDENTITY_FROZEN');
    expect(
      code(run(loadSample(), 'set_item_identity', identity).document, 'set_item_identity', { ...identity, revisionScheme: 'custom:' }),
    ).toBe('PLM_SCHEME_INVALID');
  });

  it('policy changes are a human act', () => {
    expect(run(loadSample(), 'set_item_identity', { ...identity, policy: { requireMarking: true } }, agentContext()).error?.code).toBe(
      'PLM_HUMAN_GATE',
    );
    expect(run(loadSample(), 'set_item_identity', { ...identity }, agentContext()).error).toBeUndefined();
    expect(
      run(loadSample(), 'set_item_identity', { ...identity, policy: { requireMarking: true } }).document.plm?.policy.requireMarking,
    ).toBe(true);
  });

  it('changes the scheme for future revisions only', () => {
    expect(code(loadSample(), 'set_revision_scheme', { scheme: 'numeric-2' })).toBe('PLM_NOT_MANAGED');
    const doc = released();
    expect(code(doc, 'set_revision_scheme', { scheme: 'custom:x' })).toBe('PLM_SCHEME_INVALID');
    expect(code(doc, 'set_revision_scheme', { scheme: 'nope' })).toBe('PLM_SCHEME_INVALID');
    const switched = run(doc, 'set_revision_scheme', { scheme: 'custom:x', customLabels: ['A', 'Q1'] }).document;
    expect(switched.plm?.item.revisions['A']).toBe(doc.plm?.item.revisions['A']);
    const next = run(
      run(switched, 'create_change_order', { classification: 'minor', classificationJustification: 'j' }).document,
      'revise_item',
      {},
    ).document;
    expect(next.plm?.item.currentRevision).toBe('Q1');
  });

  it('every PLM command refuses an unmanaged document without changing it', () => {
    const doc = loadSample();
    const calls: [string, unknown][] = [
      ['set_item_marking', { regime: 'none', decidedBy: 'u' }],
      ['checkpoint_iteration', {}],
      ['submit_for_review', {}],
      ['reject_review', { comment: 'x' }],
      ['record_approval', { role: 'checker', userId: 'u' }],
      ['release_item', {}],
      ['revise_item', {}],
      ['set_lifecycle_state', { revision: 'A', state: 'obsolete', reason: 'x' }],
      ['create_change_request', { title: 't', reason: 'r' }],
      ['create_change_order', {}],
      ['classify_change_order', { id: 'ECO-1', classification: 'minor', justification: 'j' }],
      ['set_change_state', { id: 'ECO-1', state: 'cancelled', reason: 'r' }],
      [
        'record_signature',
        {
          target: { kind: 'release', ref: 'A' },
          alg: 'Ed25519',
          keyId: 'k',
          publicKey: 'a',
          signature: 'b',
          meaning: 'review',
          signer: { userId: 'u', name: 'U' },
          at: T,
        },
      ],
      ['attach_release_package', { revision: 'A', manifestSha256: 'a'.repeat(64), documentContentHash: 'x' }],
      ['check_release_readiness', {}],
      ['resolve_effectivity', { kind: 'serial', unit: 1 }],
      ['release_manifest', { revision: 'A' }],
      ['view_revision', { revision: 'A' }],
      ['plm_diff', { from: 'A', to: 'B' }],
      ['verify_release', { revision: 'A' }],
      ['restore_revision_snapshot', { revision: 'A' }],
    ];
    for (const [command, params] of calls) {
      const result = run(doc, command, params);
      expect(result.error?.code, command).toBe('PLM_NOT_MANAGED');
      expect(result.document, command).toBe(doc);
    }
    expect(data<{ managed: boolean }>(doc, 'plm_status', {}).managed).toBe(false);
  });
});

describe('review, iterations and approvals (VC-PLM-01, 02, 20)', () => {
  it('checkpoints only a dirty definition and numbers iterations', () => {
    const doc = inWork();
    expect(run(doc, 'checkpoint_iteration', {}).summary).toContain('nothing to checkpoint');
    expect(run(doc, 'checkpoint_iteration', {}).document).toBe(doc);
    const edited = run(doc, 'set_parameter', { name: 't', expression: '6' }).document;
    expect(data<{ dirty: boolean }>(edited, 'plm_status', {}).dirty).toBe(true);
    const checkpointed = run(edited, 'checkpoint_iteration', { comment: 'thicker', at: T, by: 'u-1' }).document;
    expect(checkpointed.plm?.item.revisions['A']?.iterations.map((iteration) => iteration.n)).toEqual([1, 2]);
    expect(data<{ dirty: boolean }>(checkpointed, 'plm_status', {}).dirty).toBe(false);
    expect(code(inReview(), 'checkpoint_iteration', {})).toBe('PLM_STATE_TRANSITION');
  });

  it('submit checkpoints a dirty definition, freezes it and refuses bad inputs', () => {
    const edited = run(inWork(), 'set_parameter', { name: 't', expression: '6' }).document;
    const submitted = run(edited, 'submit_for_review', { comment: 'go', at: T, by: 'u-1' }).document;
    expect(submitted.plm?.item.revisions['A']).toMatchObject({ state: 'in_review' });
    expect(submitted.plm?.item.revisions['A']?.iterations).toHaveLength(2);
    expect(code(submitted, 'submit_for_review', {})).toBe('PLM_STATE_TRANSITION');
    const broken = {
      ...inWork(),
      parameters: { ...loadSample().parameters, bad: { name: 'bad', expression: '=nope', value: 0, error: 'unknown reference' } },
    };
    expect(code(broken, 'submit_for_review', {})).toBe('PLM_PARAMETER_ERRORS');
  });

  it('requireMarking blocks submit while the marking is undetermined and the statement prints on the sheet (VC-PLM-20)', () => {
    const doc = inWork({ requireMarking: true });
    expect(code(doc, 'submit_for_review', {})).toBe('PLM_MARKING_UNDECIDED');
    expect(code(doc, 'set_item_marking', { regime: 'ITAR', decidedBy: 'u-3' })).toBe('PLM_PARAM_INVALID');
    const marked = run(doc, 'set_item_marking', {
      regime: 'EAR',
      classification: 'ECCN 9A610',
      statement: 'EXPORT CONTROLLED',
      decidedBy: 'u-3',
      at: T,
    }).document;
    expect(marked.plm?.item.marking).toMatchObject({ regime: 'EAR', classification: 'ECCN 9A610', decidedAt: T });
    expect(run(marked, 'submit_for_review', {}).rejected).toBeUndefined();
    const withSheet = run(marked, 'create_sheet', { name: 'S1', views: ['front'], partNumber: 'OTHER', revision: 'Z' }).document;
    const svg = run(withSheet, 'export_sheet_svg', { sheetId: withSheet.drawings?.order[0] }).summary;
    expect(typeof svg).toBe('string');
  });

  it('records approvals once per role and user, only for policy roles, only for humans', () => {
    const doc = inReview();
    const approved = run(doc, 'record_approval', { role: 'checker', userId: 'u-2', comment: 'ok', at: T }).document;
    expect(approved.plm?.item.revisions['A']?.approvals).toEqual([{ role: 'checker', userId: 'u-2', at: T, comment: 'ok' }]);
    expect(run(approved, 'record_approval', { role: 'checker', userId: 'u-2' }).document).toBe(approved);
    expect(code(doc, 'record_approval', { role: 'janitor', userId: 'u-2' })).toBe('PLM_APPROVALS_MISSING');
    expect(code(inWork(), 'record_approval', { role: 'checker', userId: 'u' })).toBe('PLM_STATE_TRANSITION');
    expect(run(doc, 'record_approval', { role: 'checker', userId: 'u-2' }, agentContext()).error?.code).toBe('PLM_HUMAN_GATE');
  });
});

describe('change control (VC-PLM-05, 25)', () => {
  it('ECR -> ECO accepts the request and mints ids', () => {
    let doc = released();
    doc = run(doc, 'create_change_request', {
      title: 'Thicker',
      reason: 'margin',
      proposedClassification: 'minor',
      at: T,
      by: 'u-5',
    }).document;
    expect(doc.plm?.changes['ECR-0001']).toMatchObject({ kind: 'ecr', state: 'open', proposedClassification: 'minor' });
    const eco = run(doc, 'create_change_order', {
      fromRequests: ['ECR-0001'],
      title: 'Do it',
      disposition: { wip: 'rework' },
      classificationTags: ['acoustical'],
      classification: 'minor',
      at: T,
      by: 'u-5',
    }).document;
    expect(eco.plm?.changes['ECR-0001']?.state).toBe('accepted');
    expect(eco.plm?.changes['ECO-0002']).toMatchObject({
      kind: 'eco',
      purpose: 'change',
      fromRequests: ['ECR-0001'],
      disposition: { wip: 'rework' },
    });
    expect(eco.plm?.changeOrder).toEqual(['ECO-0100', 'ECR-0001', 'ECO-0002']);
  });

  it('refuses unknown or closed requests, duplicates, bad effectivity and misuse of initial-release', () => {
    const doc = released();
    expect(code(doc, 'create_change_order', { id: 'ECO-9', fromRequests: ['ECR-404'] })).toBe('PLM_ECO_UNKNOWN');
    const withEcr = run(doc, 'create_change_request', { id: 'ECR-1', title: 't', reason: 'r' }).document;
    const closed = run(withEcr, 'set_change_state', { id: 'ECR-1', state: 'rejected', reason: 'no' }).document;
    expect(code(closed, 'create_change_order', { fromRequests: ['ECR-1'] })).toBe('PLM_ECO_CLOSED');
    expect(code(doc, 'create_change_order', { id: 'ECO-0100' })).toBe('PLM_ID_EXISTS');
    expect(code(doc, 'create_change_request', { id: 'ECO-0100', title: 't', reason: 'r' })).toBe('PLM_ID_EXISTS');
    expect(code(doc, 'create_change_order', { purpose: 'initial-release' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_change_order', { effectivity: [{ kind: 'serial', from: 'x' }] })).toBe('PLM_EFFECTIVITY_UNIT_TYPE');
    expect(code(doc, 'create_change_order', { affectedItems: ['OTHER'] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_change_request', { title: ' ', reason: 'r' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_change_request', { title: 't', reason: 'r', affectedItems: ['OTHER'] })).toBe('PLM_PARAM_INVALID');
    expect(code(withEcr, 'create_change_order', { fromRequests: ['ECO-0100'] })).toBe('PLM_ECO_UNKNOWN');
  });

  it('classification is a human act, recorded separately, and never inferred', () => {
    const doc = released();
    const draft = run(doc, 'create_change_order', { id: 'ECO-5' }, agentContext());
    expect(draft.rejected).toBeUndefined();
    expect(draft.document.plm?.changes['ECO-5']?.classification).toBeUndefined();
    expect(code(doc, 'classify_change_order', { id: 'ECO-5', classification: 'minor', justification: 'j' })).toBe('PLM_ECO_UNKNOWN');
    const agent = run(
      draft.document,
      'classify_change_order',
      { id: 'ECO-5', classification: 'minor', justification: 'j' },
      agentContext(),
    );
    expect(agent.error?.code).toBe('PLM_HUMAN_GATE');
    expect(code(draft.document, 'classify_change_order', { id: 'ECO-5', classification: 'minor', justification: ' ' })).toBe(
      'PLM_PARAM_INVALID',
    );
    const classified = run(draft.document, 'classify_change_order', {
      id: 'ECO-5',
      classification: 'major',
      justification: 'new envelope',
      tags: ['emissions'],
    }).document;
    expect(classified.plm?.changes['ECO-5']).toMatchObject({ classification: 'major', classificationTags: ['emissions'] });
    const implemented = run(releasedB(), 'classify_change_order', { id: 'ECO-0200', classification: 'minor', justification: 'j' });
    expect(implemented.error?.code).toBe('PLM_ECO_CLOSED');
    expect(code(released(), 'classify_change_order', { id: 'ECO-0100', classification: 'minor', justification: 'j' })).toBe(
      'PLM_ECO_CLOSED',
    );
  });

  it('closes records with a reason; implemented is terminal; agents cannot decide', () => {
    const doc = run(released(), 'create_change_request', { id: 'ECR-1', title: 't', reason: 'r' }).document;
    expect(run(doc, 'set_change_state', { id: 'ECR-1', state: 'cancelled', reason: 'dup', at: T }, agentContext()).error?.code).toBe(
      'PLM_HUMAN_GATE',
    );
    expect(code(doc, 'set_change_state', { id: 'ECR-9', state: 'cancelled', reason: 'x' })).toBe('PLM_ECO_UNKNOWN');
    expect(code(doc, 'set_change_state', { id: 'ECR-1', state: 'cancelled', reason: ' ' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'set_change_state', { id: 'ECO-0100', state: 'cancelled', reason: 'x' })).toBe('PLM_STATE_TRANSITION');
    const cancelled = run(doc, 'set_change_state', { id: 'ECR-1', state: 'cancelled', reason: 'dup', at: T }).document;
    expect(cancelled.plm?.changes['ECR-1']).toMatchObject({ state: 'cancelled', closedAt: T });
    expect(code(cancelled, 'set_change_state', { id: 'ECR-1', state: 'rejected', reason: 'x' })).toBe('PLM_STATE_TRANSITION');
  });
});

describe('release and revise (VC-PLM-03, 05, 06, 27)', () => {
  it('release refuses each missing prerequisite with its stable code', () => {
    const doc = reviewWithEco();
    const base = { changeOrder: 'ECO-0100', approvals: APPROVALS, at: T, by: 'u-1' };
    expect(code(doc, 'release_item', { ...base, approvals: [APPROVALS[0]] })).toBe('PLM_APPROVALS_MISSING');
    expect(code(doc, 'release_item', { ...base, changeOrder: 'ECO-404' })).toBe('PLM_ECO_UNKNOWN');
    expect(code(doc, 'release_item', { ...base, effectivity: [{ kind: 'date', from: 'tomorrow' }] })).toBe('PLM_EFFECTIVITY_UNIT_TYPE');
    expect(code(inReview({ humanSignatureRequired: true }), 'release_item', { approvals: APPROVALS })).toBe('PLM_SIGNATURE_REQUIRED');
    const strict = inReview();
    const undecided = { ...strict, plm: { ...strict.plm, policy: { ...strict.plm?.policy, requireMarking: true } } } as CadDocument;
    expect(code(undecided, 'release_item', { approvals: APPROVALS })).toBe('PLM_MARKING_UNDECIDED');
    expect(code(released(), 'release_item', base)).toBe('PLM_STATE_TRANSITION');
    const ok = run(doc, 'release_item', base);
    expect(ok.document.plm?.changes['ECO-0100']).toMatchObject({ state: 'implemented', notice: 'ECN-0100' });
    expect(ok.document.plm?.item.revisions['A']).toMatchObject({
      releasedAt: T,
      releasedBy: 'u-1',
      effectivity: [{ kind: 'serial', from: 1 }],
      releasedMarking: { regime: 'undetermined' },
    });
    expect(code(ok.document, 'release_item', { ...base, changeOrder: 'ECO-0100' })).toBe('PLM_STATE_TRANSITION');
  });

  it('first release needs no ECO, a closed or foreign one is refused, a later one needs a classification', () => {
    expect(run(inReview(), 'release_item', { approvals: APPROVALS }).document.plm?.item.revisions['A']?.state).toBe('released');
    const closed = run(released(), 'create_change_order', {
      id: 'ECO-7',
      classification: 'minor',
      classificationJustification: 'j',
    }).document;
    const revised = run(closed, 'revise_item', { changeOrder: 'ECO-7' }).document;
    const review = run(revised, 'submit_for_review', {}).document;
    expect(code(review, 'release_item', { approvals: APPROVALS })).toBe('PLM_ECO_REQUIRED');
    expect(code(review, 'release_item', { approvals: APPROVALS, changeOrder: 'ECO-0100' })).toBe('PLM_ECO_CLOSED');
    const draft = run(released(), 'create_change_order', { id: 'ECO-8' }).document;
    const second = run(run(draft, 'revise_item', { changeOrder: 'ECO-8' }).document, 'submit_for_review', {}).document;
    expect(code(second, 'release_item', { approvals: APPROVALS, changeOrder: 'ECO-8' })).toBe('PLM_CLASSIFICATION_MISSING');
    const other = run(run(draft, 'create_change_request', { id: 'ECR-1', title: 't', reason: 'r' }).document, 'create_change_order', {
      id: 'ECO-9',
    }).document;
    expect(other.plm?.changes['ECO-9']?.state).toBe('open');
  });

  it('refuses an effectivity that overlaps a bounded earlier range', () => {
    let doc = run(reviewWithEco(), 'release_item', {
      changeOrder: 'ECO-0100',
      approvals: APPROVALS,
      effectivity: [{ kind: 'serial', from: 1, to: 10 }],
    }).document;
    doc = run(doc, 'create_change_order', {
      id: 'ECO-2',
      classification: 'minor',
      classificationJustification: 'j',
      effectivity: [{ kind: 'serial', from: 5 }],
    }).document;
    doc = run(run(doc, 'revise_item', { changeOrder: 'ECO-2' }).document, 'submit_for_review', {}).document;
    expect(code(doc, 'release_item', { changeOrder: 'ECO-2', approvals: APPROVALS })).toBe('PLM_EFFECTIVITY_OVERLAP');
  });

  it('revise picks the single open ECO, and refuses unreleased, unknown, closed or foreign ECOs', () => {
    expect(code(inWork(), 'revise_item', {})).toBe('PLM_STATE_TRANSITION');
    const doc = run(released(), 'create_change_order', { id: 'ECO-3', classification: 'minor', classificationJustification: 'j' }).document;
    expect(code(doc, 'revise_item', { changeOrder: 'ECO-404' })).toBe('PLM_ECO_UNKNOWN');
    expect(code(doc, 'revise_item', { changeOrder: 'ECO-0100' })).toBe('PLM_ECO_CLOSED');
    expect(run(doc, 'revise_item', {}).document.plm?.item.revisions['B']?.changeOrder).toBe('ECO-3');
    const ecr = run(doc, 'create_change_request', { id: 'ECR-1', title: 't', reason: 'r' }).document;
    expect(code(ecr, 'revise_item', { changeOrder: 'ECR-1' })).toBe('PLM_ECO_UNKNOWN');
    const relaxed = run(released({ requireChangeOrder: false }), 'revise_item', {}).document;
    expect(relaxed.plm?.item.revisions['B']).toMatchObject({ state: 'in_work', basedOn: 'A' });
  });

  it('revise stops at the end of a custom scheme', () => {
    let doc = run(loadSample(), 'set_item_identity', {
      partNumber: 'LL-9',
      name: 'n',
      itemType: 'part',
      revisionScheme: 'custom:one',
      customLabels: ['A'],
      policy: { humanSignatureRequired: false, requireChangeOrder: false },
    }).document;
    doc = run(run(doc, 'submit_for_review', {}).document, 'release_item', { approvals: APPROVALS }).document;
    expect(code(doc, 'revise_item', {})).toBe('PLM_SCHEME_INVALID');
  });
});

describe('queries (VC-PLM-12, 27)', () => {
  it('plm_status names policy defaults, integrity, open changes and the next human action', () => {
    const doc = run(reviewWithEco(), 'create_change_request', { id: 'ECR-1', title: 't', reason: 'r' }).document;
    const status = data<Record<string, unknown>>(doc, 'plm_status', {});
    expect(status['policy']).toMatchObject({
      humanSignatureRequired: { value: false, defaulted: false, source: 'document policy' },
      requireChangeOrder: { value: true, defaulted: true, source: 'llull default' },
    });
    expect(status['openChanges']).toHaveLength(2);
    expect(status['nextHumanAction']).toContain('release_item');
    const fresh = data<{ policy: { humanSignatureRequired: { defaulted: boolean } } }>(
      run(loadSample(), 'set_item_identity', { partNumber: 'A1', name: 'n', itemType: 'part' }).document,
      'plm_status',
      {},
    );
    expect(fresh.policy.humanSignatureRequired.defaulted).toBe(true);
  });

  it('check_release_readiness lists blockers, warnings and the humans who must act without changing anything', () => {
    const doc = run(inReview({ humanSignatureRequired: true, requireMarking: true }), 'create_material', {
      name: 'mystery',
      density: 0.00278,
      color: '#aaaaaa',
    }).document;
    const graded = {
      ...doc,
      materials: { ...doc.materials, mystery: { ...(doc.materials['mystery'] as object), grade: 'C' as const } },
    } as unknown as CadDocument;
    const result = run(graded, 'check_release_readiness', { changeOrder: 'ECO-404' });
    expect(result.document).toBe(graded);
    const report = result.data as { status: string; findings: { code: string }[]; humanActionsNeeded: { act: string }[] };
    expect(report.status).toBe('fail');
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'PLM_ECO_UNKNOWN',
        'PLM_APPROVALS_MISSING',
        'PLM_SIGNATURE_REQUIRED',
        'PLM_MARKING_UNDECIDED',
        'PLM_UNVERIFIED_INPUT',
      ]),
    );
    expect(report.humanActionsNeeded.map((action) => action.act).join(' ')).toContain('record_approval');
    const ready = data<{ status: string }>(released(), 'check_release_readiness', {});
    expect(ready.status).toBe('fail');
    const clean = data<{ status: string; findings: unknown[] }>(
      run(reviewWithEco(), 'check_release_readiness', { changeOrder: 'ECO-0100' }).document,
      'check_release_readiness',
      { changeOrder: 'ECO-0100' },
    );
    expect(clean.findings.map((finding) => (finding as { code: string }).code)).toEqual(['PLM_APPROVALS_MISSING']);
  });

  it('flags a sheet title block that disagrees with the managed identity', () => {
    const drawn = run(inWork(), 'create_sheet', { name: 'S1', views: ['front'], partNumber: 'OTHER', revision: 'Z' }).document;
    const sheet = run(run(drawn, 'submit_for_review', {}).document, 'create_change_order', {
      id: 'ECO-0100',
      purpose: 'initial-release',
    }).document;
    const report = data<{ findings: { code: string; ids: string[] }[] }>(sheet, 'check_release_readiness', { changeOrder: 'ECO-0100' });
    expect(report.findings.find((finding) => finding.code === 'PLM_TITLEBLOCK_MISMATCH')?.ids).toHaveLength(1);
  });

  it('resolve_effectivity validates its units and item', () => {
    const doc = releasedB();
    expect(data<{ revision: string }>(doc, 'resolve_effectivity', { partNumber: 'LL-2001', kind: 'serial', unit: 4 }).revision).toBe('A');
    expect(data<{ revision: string }>(doc, 'resolve_effectivity', { kind: 'serial', unit: 5 }).revision).toBe('B');
    expect(code(doc, 'resolve_effectivity', { kind: 'serial', unit: 'five' })).toBe('PLM_EFFECTIVITY_UNIT_TYPE');
    expect(code(doc, 'resolve_effectivity', { partNumber: 'OTHER', kind: 'serial', unit: 1 })).toBe('PLM_PARAM_INVALID');
  });

  it('plm_diff compares snapshots and the working document (S1 step 13)', () => {
    const doc = releasedB();
    const diff = data<{ parameters: { changed: unknown[] }; featureHistory: { added: number }; effectivity: { from: unknown } }>(
      doc,
      'plm_diff',
      { from: 'A', to: 'B' },
    );
    expect(diff.parameters.changed).toEqual([{ name: 't', from: '4', to: '5' }]);
    expect(diff.featureHistory.added).toBe(0);
    expect(diff.effectivity.from).toEqual([{ kind: 'serial', from: 1, to: 4 }]);
    const edited = run(
      run(released(), 'create_change_order', { classification: 'minor', classificationJustification: 'j' }).document,
      'revise_item',
      {},
    ).document;
    const working = run(edited, 'add_box', { size: [1, 1, 1] }).document;
    const against = data<{ entities: { added: string[] }; featureHistory: { added: number; steps: { change: string }[] } }>(
      working,
      'plm_diff',
      { from: 'A', to: 'WORKING' },
    );
    expect(against.entities.added).toHaveLength(1);
    expect(against.featureHistory.steps.map((step) => step.change)).toEqual(['added']);
    expect(code(working, 'plm_diff', { from: 'A', to: 'Z' })).toBe('PLM_NO_SNAPSHOT');
    expect(code(inWork(), 'plm_diff', { from: 'A', to: 'WORKING' })).toBeUndefined();
    const retitled = run(run(doc, 'view_revision', { revision: 'A' }).document, 'plm_status', {}).document;
    expect(retitled).toBe(doc);
  });

  it('view_revision returns the frozen definition; release_manifest is deterministic', () => {
    const doc = releasedB();
    const view = data<{ format: string; document: { parameters: Record<string, { expression: string }> } }>(doc, 'view_revision', {
      revision: 'A',
    });
    expect(view.format).toBe('llull-document');
    expect(view.document.parameters['t']?.expression).toBe('4');
    expect(code(doc, 'view_revision', { revision: 'Z' })).toBe('PLM_REVISION_UNKNOWN');
    expect(code(inWork(), 'view_revision', { revision: 'A' })).toBe('PLM_NO_SNAPSHOT');
    const manifest = data<{
      canonical: string;
      sha256: string;
      body: { documentContentHash: string; lifecycleState: string; effectivity: unknown };
    }>(doc, 'release_manifest', { revision: 'A' });
    expect(manifest.body.documentContentHash).toBe(doc.plm?.item.revisions['A']?.contentHash);
    expect(manifest.body.lifecycleState).toBe('released');
    expect(manifest.body.effectivity).toEqual([{ kind: 'serial', from: 1 }]);
    expect(data<{ sha256: string }>(doc, 'release_manifest', { revision: 'A' }).sha256).toBe(manifest.sha256);
    expect(data<{ body: { schema: string } }>(inReview(), 'release_manifest', { revision: 'A', kind: 'iteration' }).body.schema).toBe(
      'llull-iteration-manifest/0.1',
    );
    expect(code(inReview(), 'release_manifest', { revision: 'A' })).toBe('PLM_NOT_RELEASED');
    expect(code(doc, 'release_manifest', { revision: 'Z' })).toBe('PLM_REVISION_UNKNOWN');
  });

  it('a fresh empty document has no plm slice and the tool survives it', () => {
    expect(createEmptyDocument().plm).toBeUndefined();
  });
});
