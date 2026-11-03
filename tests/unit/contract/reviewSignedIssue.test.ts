/** A human-signed issue is byte-identical after every command that writes review.issues, and check_review stays clean (the signature covers the whole issue). */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute, getCommand } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { confirmationOver, ledgerPort } from '../review/humanActs';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});
const ctxOf = (): ExecutionContext => ({ ...defaultContext(), kernel, humanSignature: ledgerPort() });

function run(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params, ctxOf());
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result.document;
}

/** Two overlapping cubes, a clash issue for them (iss-2), a bcf of that issue, the issue resolved then closed by a human. */
function signedClosed(): { doc: CadDocument; bcf: string } {
  let doc = createEmptyDocument();
  doc = run(doc, 'add_box', { size: [20, 20, 20] });
  doc = run(doc, 'add_box', { size: [20, 20, 20], position: [10, 0, 0] });
  doc = run(doc, 'create_clash_issues', { source: 'check_assembly' });
  const bcf = (execute(doc, 'export_bcf', { snapshots: false }).data as { base64: string }).base64;
  doc = run(doc, 'set_issue_status', { issueId: 'iss-2', status: 'resolved', reason: 'moved' });
  const params = { issueId: 'iss-2', status: 'closed', reason: 'accepted' };
  doc = run(doc, 'set_issue_status', { ...params, confirmation: confirmationOver(doc, params) });
  expect(doc.review?.issues['iss-2']?.history.at(-1)?.by).toBe('human');
  return { doc, bcf };
}

const cleanReview = (doc: CadDocument): void => {
  const result = execute(doc, 'check_review', {}, ctxOf());
  const rows = (result.data as { issues: { code: string }[]; status: string }).issues.map((row) => row.code);
  expect(rows).not.toContain('VIS_HUMAN_GATE');
  expect((result.data as { status: string }).status).not.toBe('fail');
};

describe('commands that write review.issues leave a signed issue untouched', () => {
  const WRITERS = [
    'create_clash_issues',
    'import_bcf',
    'create_review_issue',
    'add_review_comment',
    'set_issue_status',
    'save_viewpoint',
    'update_viewpoint',
    'import_bcf_viewpoint',
  ];

  it('every writer is a registered command', () => {
    expect(WRITERS.filter((name) => getCommand(name) === undefined)).toEqual([]);
  });

  it('create_clash_issues re-run after the clash changed', () => {
    const { doc } = signedClosed();
    const moved = run(doc, 'move_entities', { ids: [doc.order[1] ?? ''], delta: [4, 0, 0] });
    const again = execute(moved, 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    expect(again.document.review?.issues['iss-2']).toEqual(doc.review?.issues['iss-2']);
    expect(JSON.stringify(again.document.review?.issues['iss-2'])).toBe(JSON.stringify(doc.review?.issues['iss-2']));
    expect((again.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['VIS_CLASH_ISSUE_SIGNED']);
    cleanReview(again.document);
  });

  it('import_bcf update (and skip) of the signed topic', () => {
    const { doc, bcf } = signedClosed();
    const edited = JSON.parse(JSON.stringify(doc)) as CadDocument;
    for (const policy of ['update', 'skip']) {
      const result = execute(edited, 'import_bcf', { bcf, mergePolicy: policy }, ctxOf());
      expect(JSON.stringify(result.document.review?.issues['iss-2'])).toBe(JSON.stringify(doc.review?.issues['iss-2']));
      expect(result.data).toMatchObject({ updated: 0, skipped: 1 });
      if (policy === 'update')
        expect((result.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toContain('VIS_BCF_ISSUE_SIGNED');
      cleanReview(result.document);
    }
  });

  it('every other writer keeps the issue and the review clean', () => {
    const { doc } = signedClosed();
    const before = JSON.stringify(doc.review?.issues['iss-2']);
    const attempts: [string, Record<string, unknown>][] = [
      ['create_review_issue', { title: 'another' }],
      ['add_review_comment', { issueId: 'iss-2', text: 'late remark' }],
      ['set_issue_status', { issueId: 'iss-2', status: 'open', reason: 'agent reopen' }],
      ['save_viewpoint', { name: 'v', fromDocumentCamera: true }],
      ['update_viewpoint', { id: 'vp-1', name: 'renamed' }],
    ];
    for (const [name, params] of attempts) {
      const result = execute(doc, name, params, ctxOf());
      expect(JSON.stringify(result.document.review?.issues['iss-2']), name).toBe(before);
      cleanReview(result.document);
    }
  });
});
