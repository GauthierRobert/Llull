/** VIS-M2: markups, comments, the issue workflow with the human gate (VC-VIS-13 / 14 / 50), check_review and the persisted review model. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { reviewProblems } from '@core/commands/persistence/reviewValidation';
import { deleteIssue, humanCtx } from './humanActs';

/** skid + pipe, one viewpoint, one issue citing both entities and the viewpoint. */
function reviewed(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
  doc = execute(doc, 'add_box', { size: [5, 5, 5], position: [50, 0, 0] }).document;
  doc = execute(doc, 'save_viewpoint', { name: 'skid review', fromDocumentCamera: true }).document;
  const [skid, pipe] = doc.order;
  return execute(doc, 'create_review_issue', {
    title: 'Nozzle faces the walkway',
    viewpointIds: ['vp-1'],
    entityIds: [skid, pipe],
    assignedTo: 'ana@example.org',
    dueDate: '2026-12-01',
  }).document;
}

/** The confirmation a human makes for `status` on `issueId`: a signature over exactly the payload review_act_payload reports. */
function confirmationFor(doc: CadDocument, status: string, reason: string, as = 'grace', nonce = 'n-1'): Record<string, unknown> {
  const payload = execute(doc, 'review_act_payload', { issueId: 'iss-2', status, reason, nonce }).data as { payloadSha256: string };
  return { alg: 'Ed25519', as, nonce, signature: payload.payloadSha256 };
}

describe('add_markup / delete_markup', () => {
  it('adds screen and world markups with deterministic ids and no feature step', () => {
    const doc = reviewed();
    const cloud = execute(doc, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'cloud',
      space: 'screen',
      points: [
        [0.4, 0.35],
        [0.62, 0.35],
        [0.62, 0.58],
        [0.4, 0.58],
      ],
      colour: '#E03030',
      text: ' check nozzle ',
    });
    expect(cloud.affected).toEqual(['mk-3']);
    expect(cloud.document.review?.markups['mk-3']).toMatchObject({
      shape: 'cloud',
      colour: '#e03030',
      text: 'check nozzle',
      author: 'agent',
    });
    expect(cloud.document.featureHistory).toEqual(doc.featureHistory);
    const arrow = execute(cloud.document, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'arrow',
      space: 'world',
      points: [
        [1500, 0, 1500],
        [500, 0, 800],
      ],
      colour: '#e03030',
      lineWidthPx: 3,
      author: 'human',
    });
    expect(arrow.document.review?.markups['mk-4']).toMatchObject({ lineWidthPx: 3, author: 'human', space: 'world' });
    const note = execute(arrow.document, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'text',
      space: 'screen',
      points: [[0.5, 0.5]],
      colour: '#000000',
      text: 'here',
    });
    expect(note.affected).toEqual(['mk-5']);
    const removed = execute(note.document, 'delete_markup', { id: 'mk-3' });
    expect(removed.affected).toEqual(['mk-3']);
    expect(Object.keys(removed.document.review?.markups ?? {})).toEqual(['mk-4', 'mk-5']);
  });

  it('refuses bad input with coded no-ops (VC-VIS-50)', () => {
    const doc = reviewed();
    const base = {
      viewpointId: 'vp-1',
      shape: 'line',
      space: 'screen',
      points: [
        [0, 0],
        [1, 1],
      ],
      colour: '#112233',
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ viewpointId: 'vp-9' }, 'VIS_VIEWPOINT_NOT_FOUND'],
      [{ colour: 'red' }, 'VIS_COLOUR_INVALID'],
      [
        {
          points: [
            [0, 0],
            [1.2, 0.5],
          ],
        },
        'VIS_MARKUP_INVALID',
      ],
      [{ points: [[0, 0]] }, 'VIS_MARKUP_INVALID'],
      [
        {
          points: [
            [0, 0, 0],
            [1, 1, 1],
          ],
        },
        'VIS_MARKUP_INVALID',
      ],
      [{ shape: 'cloud' }, 'VIS_MARKUP_INVALID'],
      [{ shape: 'text', points: [[0.5, 0.5]] }, 'VIS_MARKUP_INVALID'],
      [
        {
          space: 'world',
          points: [
            [0, 0, 0],
            [1, 1],
          ],
        },
        'VIS_MARKUP_INVALID',
      ],
    ];
    for (const [patch, code] of cases) {
      const result = execute(doc, 'add_markup', { ...base, ...patch });
      expect(result.error?.code, JSON.stringify(patch)).toBe(code);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(execute(doc, 'delete_markup', { id: 'mk-9' }).error?.code).toBe('VIS_MARKUP_NOT_FOUND');
  });

  it('deleting a viewpoint deletes its markups and uncites it from comments', () => {
    let doc = reviewed();
    doc = execute(doc, 'save_viewpoint', { name: 'second', fromDocumentCamera: true }).document;
    doc = execute(doc, 'add_markup', {
      viewpointId: 'vp-3',
      shape: 'line',
      space: 'screen',
      points: [
        [0, 0],
        [1, 1],
      ],
      colour: '#112233',
    }).document;
    doc = execute(doc, 'add_review_comment', { issueId: 'iss-2', text: 'see this', viewpointId: 'vp-3' }).document;
    const deleted = execute(doc, 'delete_viewpoint', { id: 'vp-3' });
    expect(deleted.document.review?.markups).toEqual({});
    expect(deleted.document.review?.comments['cm-5']).toEqual({ id: 'cm-5', issueId: 'iss-2', text: 'see this', author: 'agent' });
    expect(deleted.summary).toContain('1 markup(s)');
  });
});

describe('add_review_comment and create_review_issue extensions', () => {
  it('adds a comment citing a viewpoint, trimming the text', () => {
    const result = execute(reviewed(), 'add_review_comment', {
      issueId: 'iss-2',
      text: '  Rotate the skid.  ',
      viewpointId: 'vp-1',
      author: 'human',
    });
    expect(result.affected).toEqual(['cm-3']);
    expect(result.document.review?.comments['cm-3']).toEqual({
      id: 'cm-3',
      issueId: 'iss-2',
      text: 'Rotate the skid.',
      viewpointId: 'vp-1',
      author: 'human',
    });
  });

  it('refuses an unknown issue, an empty text and an unknown viewpoint', () => {
    const doc = reviewed();
    expect(execute(doc, 'add_review_comment', { issueId: 'iss-9', text: 'x' }).error?.code).toBe('VIS_ISSUE_NOT_FOUND');
    expect(execute(doc, 'add_review_comment', { issueId: 'iss-2', text: '  ' }).error?.code).toBe('VIS_COMMENT_INVALID');
    const ghost = execute(doc, 'add_review_comment', { issueId: 'iss-2', text: 'x', viewpointId: 'vp-9' });
    expect(ghost.error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(ghost.document).toBe(doc);
  });

  it('stores assignedTo and dueDate and refuses a bad date; deleting the issue deletes its comments', () => {
    const doc = reviewed();
    expect(doc.review?.issues['iss-2']).toMatchObject({
      assignedTo: 'ana@example.org',
      dueDate: '2026-12-01',
      status: 'open',
      history: [],
    });
    for (const dueDate of ['01/12/2026', '2026-02-30']) {
      const result = execute(doc, 'create_review_issue', { title: 't', dueDate });
      expect(result.error?.code).toBe('VIS_ISSUE_INVALID');
    }
    const commented = execute(doc, 'add_review_comment', { issueId: 'iss-2', text: 'a' }).document;
    const deleted = deleteIssue(commented, 'iss-2');
    expect(deleted.document.review?.comments).toEqual({});
    expect(deleted.summary).toContain('1 comment(s)');
  });
});

describe('set_issue_status and the human gate (VC-VIS-14, TR-VIS-15)', () => {
  it('lets an agent move an issue open -> in_progress -> resolved and records the history', () => {
    let doc = reviewed();
    doc = execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'in_progress', reason: 'looking' }).document;
    const resolved = execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: ' skid moved ' });
    expect(resolved.affected).toEqual(['iss-2']);
    expect(resolved.document.review?.issues['iss-2']?.status).toBe('resolved');
    expect(resolved.document.review?.issues['iss-2']?.history).toEqual([
      { status: 'in_progress', by: 'agent', reason: 'looking' },
      { status: 'resolved', by: 'agent', reason: 'skid moved' },
    ]);
    expect(resolved.data).toMatchObject({ status: 'resolved' });
    const reopened = execute(resolved.document, 'set_issue_status', { issueId: 'iss-2', status: 'open', reason: 'again' });
    expect(reopened.document.review?.issues['iss-2']?.status).toBe('open');
  });

  it('refuses closing for an agent (VIS_HUMAN_GATE) whatever it claims, with or without a signing port', () => {
    const doc = execute(reviewed(), 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document;
    const params = { issueId: 'iss-2', status: 'closed', reason: 'accept' };
    const forged = { alg: 'Ed25519', as: 'grace', nonce: 'n-1', signature: 'forged' };
    const other = confirmationFor(doc, 'closed', 'another reason');
    for (const ctx of [undefined, humanCtx(), { ...defaultContext(), humanSignature: null }]) {
      for (const confirmation of [undefined, {}, forged, other]) {
        const result = execute(doc, 'set_issue_status', { ...params, ...(confirmation === undefined ? {} : { confirmation }) }, ctx);
        expect(result.error?.code, JSON.stringify(confirmation)).toBe('VIS_HUMAN_GATE');
        expect(result.document).toBe(doc);
        expect(result.affected).toEqual([]);
      }
    }
  });

  it('closes with a human signature over exactly this act and records who signed; re-opening a closed issue is human too', () => {
    const doc = execute(reviewed(), 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document;
    const closed = execute(
      doc,
      'set_issue_status',
      { issueId: 'iss-2', status: 'closed', reason: 'accept', confirmation: confirmationFor(doc, 'closed', 'accept') },
      humanCtx(),
    );
    expect(closed.error).toBeUndefined();
    const issue = closed.document.review?.issues['iss-2'];
    expect(issue?.status).toBe('closed');
    expect(issue?.history.at(-1)).toEqual({
      status: 'closed',
      by: 'human',
      reason: 'accept',
      signatureId: 'fake:grace',
      signer: 'grace',
      proof: confirmationFor(doc, 'closed', 'accept'),
    });
    expect(closed.summary).toContain('by human (grace)');
    const agentReopen = execute(closed.document, 'set_issue_status', { issueId: 'iss-2', status: 'open', reason: 'oops' });
    expect(agentReopen.error?.code).toBe('VIS_HUMAN_GATE');
    const stale = execute(
      closed.document,
      'set_issue_status',
      { issueId: 'iss-2', status: 'closed', reason: 'accept', confirmation: confirmationFor(doc, 'closed', 'accept') },
      humanCtx(),
    );
    expect(stale.error?.code).toBe('VIS_ISSUE_STATUS_INVALID');
    const reopened = execute(
      closed.document,
      'set_issue_status',
      {
        issueId: 'iss-2',
        status: 'open',
        reason: 'new finding',
        confirmation: confirmationFor(closed.document, 'open', 'new finding', 'grace', 'n-2'),
      },
      humanCtx(),
    );
    expect(reopened.document.review?.issues['iss-2']?.status).toBe('open');
  });

  it('a signature is bound to the state: it does not verify after the history changed', () => {
    const doc = execute(reviewed(), 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document;
    const confirmation = confirmationFor(doc, 'closed', 'accept');
    const moved = execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'in_progress', reason: 'wait' }).document;
    const result = execute(moved, 'set_issue_status', { issueId: 'iss-2', status: 'closed', reason: 'accept', confirmation }, humanCtx());
    expect(result.error?.code).toBe('VIS_HUMAN_GATE');
  });

  it('records a valid signature on a non-gated move as a human act, and refuses a bad one', () => {
    const doc = reviewed();
    const signed = execute(
      doc,
      'set_issue_status',
      { issueId: 'iss-2', status: 'resolved', reason: 'fixed', confirmation: confirmationFor(doc, 'resolved', 'fixed') },
      humanCtx(),
    );
    expect(signed.document.review?.issues['iss-2']?.history[0]).toMatchObject({ by: 'human', signer: 'grace' });
    const bad = execute(
      doc,
      'set_issue_status',
      { issueId: 'iss-2', status: 'resolved', reason: 'fixed', confirmation: { nonce: 'n', signature: 'x' } },
      humanCtx(),
    );
    expect(bad.error?.code).toBe('VIS_HUMAN_GATE');
  });

  it('refuses unknown issues, same-status and out-of-workflow moves and empty reasons (VIS_ISSUE_STATUS_INVALID)', () => {
    const doc = reviewed();
    expect(execute(doc, 'set_issue_status', { issueId: 'iss-9', status: 'resolved', reason: 'x' }).error?.code).toBe('VIS_ISSUE_NOT_FOUND');
    expect(execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'open', reason: 'x' }).error?.code).toBe(
      'VIS_ISSUE_STATUS_INVALID',
    );
    expect(execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: '  ' }).error?.code).toBe(
      'VIS_ISSUE_STATUS_INVALID',
    );
    const closedByHand = {
      ...doc,
      review: { ...doc.review!, issues: { 'iss-2': { ...doc.review!.issues['iss-2']!, status: 'closed' as const } } },
    };
    const result = execute(closedByHand, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'x' });
    expect(result.error?.code).toBe('VIS_ISSUE_STATUS_INVALID');
    expect(result.summary).toContain('closed -> resolved');
  });

  it('review_act_payload is read-only, deterministic and refuses unknown issues and impossible moves', () => {
    const doc = reviewed();
    const first = execute(doc, 'review_act_payload', { issueId: 'iss-2', status: 'closed', reason: 'ok', nonce: 'n' });
    const again = execute(doc, 'review_act_payload', { issueId: 'iss-2', status: 'closed', reason: ' ok ', nonce: 'n' });
    expect(first.data).toMatchObject({ act: 'review:set_issue_status', from: 'open', to: 'closed' });
    expect((again.data as { payloadSha256: string }).payloadSha256).toBe((first.data as { payloadSha256: string }).payloadSha256);
    expect((first.data as { payloadSha256: string }).payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.document).toBe(doc);
    expect(execute(doc, 'review_act_payload', { issueId: 'iss-9', status: 'closed', reason: 'ok', nonce: 'n' }).error?.code).toBe(
      'VIS_ISSUE_NOT_FOUND',
    );
    expect(execute(doc, 'review_act_payload', { issueId: 'iss-2', status: 'open', reason: 'ok', nonce: 'n' }).error?.code).toBe(
      'VIS_ISSUE_STATUS_INVALID',
    );
  });
});

describe('check_review (VC-VIS-14)', () => {
  const data = (
    doc: CadDocument,
    params: Record<string, unknown> = {},
    ctx?: ExecutionContext,
  ): { status: string; issues: { code: string; ids: string[]; severity: string }[]; counts: Record<string, unknown> } =>
    execute(doc, 'check_review', params, ctx).data as never;

  it('passes an empty document and reports counts', () => {
    expect(data(createEmptyDocument())).toMatchObject({ status: 'pass', issues: [], counts: { viewpoints: 0, markups: 0 } });
  });

  it('reports open issues as info, resolved as awaiting approval, and an issue citing a deleted entity', () => {
    const doc = reviewed();
    const open = data(doc);
    expect(open.status).toBe('pass');
    expect(open.issues.map((row) => row.code)).toEqual(['VIS_ISSUE_OPEN']);
    expect(data(doc, { includeInfo: false }).issues).toEqual([]);
    const deleted = execute(doc, 'delete_entities', { ids: [doc.order[0]] }).document;
    const stale = data(deleted);
    expect(stale.status).toBe('warn');
    expect(stale.issues.map((row) => [row.code, row.ids])).toEqual([
      ['VIS_ISSUE_OPEN', ['iss-2']],
      ['VIS_ISSUE_ENTITY_MISSING', ['iss-2']],
    ]);
    const resolved = execute(deleted, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'design change' }).document;
    expect(data(resolved).issues.map((row) => row.code)).toEqual(['VIS_ISSUE_AWAITING_APPROVAL', 'VIS_ISSUE_ENTITY_MISSING']);
    expect(execute(resolved, 'check_review', {}).summary).toContain('VIS_ISSUE_AWAITING_APPROVAL x1');
  });

  it('flags a viewpoint whose selection or visibility names a deleted entity', () => {
    let doc = reviewed();
    const target = doc.order[1] ?? '';
    doc = execute(doc, 'save_viewpoint', { name: 'sel', fromDocumentCamera: true, selection: [target] }).document;
    doc = execute(doc, 'save_viewpoint', {
      name: 'vis',
      fromDocumentCamera: true,
      visibility: { defaultVisible: true, exceptions: [target] },
    }).document;
    expect(data(doc).issues.map((row) => row.code)).not.toContain('VIS_VIEWPOINT_STALE');
    const deleted = execute(doc, 'delete_entities', { ids: [target] }).document;
    expect(data(deleted).issues.find((row) => row.code === 'VIS_VIEWPOINT_STALE')?.ids).toEqual(['vp-3', 'vp-4']);
  });

  it('fails when a closed issue was not closed by a human (file edited outside the commands)', () => {
    const doc = reviewed();
    const forged = {
      ...doc,
      review: {
        ...doc.review!,
        issues: {
          'iss-2': {
            ...doc.review!.issues['iss-2']!,
            status: 'closed' as const,
            history: [{ status: 'closed' as const, by: 'agent' as const, reason: 'x' }],
          },
        },
      },
    };
    const result = data(forged);
    expect(result.status).toBe('fail');
    expect(result.issues.find((row) => row.code === 'VIS_HUMAN_GATE')).toMatchObject({ severity: 'error', ids: ['iss-2'] });
    const signed = execute(
      execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document,
      'set_issue_status',
      {
        issueId: 'iss-2',
        status: 'closed',
        reason: 'accept',
        confirmation: confirmationFor(
          execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document,
          'closed',
          'accept',
        ),
      },
      humanCtx(),
    ).document;
    expect(data(signed, {}, humanCtx())).toMatchObject({ status: 'pass', counts: { issues: { closed: 1, open: 0 } } });
    expect(data(signed).issues.map((row) => row.code)).toEqual(['VIS_SIGNATURE_UNVERIFIED']);
  });

  it('is pure', () => {
    const doc = reviewed();
    const before = JSON.stringify(doc);
    execute(doc, 'check_review', {});
    execute(doc, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'line',
      space: 'screen',
      points: [
        [0, 0],
        [1, 1],
      ],
      colour: '#112233',
    });
    execute(doc, 'add_review_comment', { issueId: 'iss-2', text: 'x' });
    execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'x' });
    execute(doc, 'delete_review_issue', { id: 'iss-2' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('the review model persists (VC-VIS-13)', () => {
  function full(): CadDocument {
    let doc = reviewed();
    doc = execute(doc, 'set_section_box', { name: 'box', min: [-20, -20, -20], max: [20, 20, 20] }).document;
    doc = execute(doc, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'line',
      space: 'screen',
      points: [
        [0, 0],
        [1, 1],
      ],
      colour: '#112233',
    }).document;
    doc = execute(doc, 'add_review_comment', { issueId: 'iss-2', text: 'hi', viewpointId: 'vp-1' }).document;
    doc = execute(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'done' }).document;
    return doc;
  }

  it('survives a JSON round trip and validates', () => {
    const doc = full();
    const reloaded = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    expect(validateDocumentValues(reloaded)).toEqual([]);
    expect((reloaded['review'] as { nextNumber: number }).nextNumber).toBe(6);
    expect(JSON.parse(JSON.stringify(doc.review))).toEqual(doc.review);
  });

  it('replays the same commands to the same ids', () => {
    expect(JSON.stringify(full().review)).toBe(JSON.stringify(full().review));
  });

  it('reports malformed sections on load', () => {
    const review = JSON.parse(JSON.stringify(full().review)) as Record<string, Record<string, Record<string, unknown>>>;
    const problems = (patch: Record<string, unknown>): string => reviewProblems({ ...review, ...patch }).join(' | ');
    expect(problems({ markups: { 'mk-4': { id: 'mk-4', viewpointId: 'vp-9' } } })).toContain('viewpointId must name a viewpoint');
    const markup = review['markups']?.['mk-4'] ?? {};
    expect(problems({ markups: { 'mk-4': { ...markup, shape: 'blob' } } })).toContain('shape is not a markup shape');
    expect(problems({ markups: { 'mk-4': { ...markup, space: 'sky' } } })).toContain("space must be 'screen' or 'world'");
    expect(problems({ markups: { 'mk-4': { ...markup, points: [[0, 0, 0]] } } })).toContain('points must be finite 2-component arrays');
    expect(problems({ markups: { 'mk-4': { ...markup, colour: 'red' } } })).toContain('colour must be #rrggbb');
    expect(problems({ markups: { 'mk-4': { ...markup, author: 'bot' } } })).toContain('author must be');
    const comment = review['comments']?.['cm-5'] ?? {};
    expect(problems({ comments: { 'cm-5': { ...comment, issueId: 'iss-9' } } })).toContain('issueId must name an issue');
    expect(problems({ comments: { 'cm-5': { ...comment, text: 1 } } })).toContain('text must be a string');
    expect(problems({ comments: { 'cm-5': { ...comment, viewpointId: 'vp-9' } } })).toContain('viewpointId must name a viewpoint');
    expect(problems({ comments: { 'cm-5': { ...comment, author: 'bot' } } })).toContain('author must be');
    const issue = review['issues']?.['iss-2'] ?? {};
    expect(problems({ issues: { 'iss-2': { ...issue, status: 'done' } } })).toContain('status is not an issue status');
    expect(problems({ issues: { 'iss-2': { ...issue, priority: 'urgent' } } })).toContain('priority is not an issue priority');
    expect(problems({ issues: { 'iss-2': { ...issue, history: 'x' } } })).toContain('history must be an array');
    expect(problems({ issues: { 'iss-2': { ...issue, history: [{ status: 'closed', by: 'human', reason: 'x' }] } } })).toContain(
      'carries signatureId',
    );
    const viewpoint = review['viewpoints']?.['vp-1'] ?? {};
    expect(problems({ viewpoints: { 'vp-1': { ...viewpoint, sectionBoxId: 'sb-9' } } })).toContain('sectionBoxId must name a section box');
    expect(problems({ viewpoints: { 'vp-1': { ...viewpoint, colourProfileId: 'ghost' } } })).toContain('colourProfileId must name');
    expect(problems({ viewpoints: { 'vp-1': { ...viewpoint, selection: 3 } } })).toContain('selection must be a string array');
    expect(problems({ viewpoints: { 'vp-1': { ...viewpoint, visibility: { defaultVisible: 1 } } } })).toContain('visibility must be');
    expect(problems({ nextNumber: 2 })).toContain('nextNumber');
    const legacy = Object.fromEntries(Object.entries(review).filter(([key]) => key !== 'sectionBoxes'));
    expect(reviewProblems(legacy)).toHaveLength(1);
  });
});
