/** Plant 05 ISO-REPLAY: the human-gated issue_isometric survives replay_history / regeneration, only for the content a human signed. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import { fabricationErrors } from '@aec/plant/fabrication/validate';
import { apply, data } from '../../../helpers/commandAssertions';
import { loadedL101 } from './isoM2Fixtures';

const AT = '2026-11-02T09:30:00Z';
const port: HumanSignaturePort = { verify: () => ({ signer: 'alice', signatureId: 'sig-1' }) };
const ctx: ExecutionContext = { ...defaultContext(), humanSignature: port };
const params = { lineId: 'L-101', revision: 'A', purpose: 'for_construction', at: AT };

const numberedDoc = (): CadDocument => apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
const issued = (): CadDocument => {
  const defined = apply(numberedDoc(), 'define_isometric', { lineId: 'L-101', paper: 'A3' });
  const result = execute(defined, 'issue_isometric', { ...params, confirmation: { nonce: 'n1' } }, ctx);
  expect(result.error, result.summary).toBeUndefined();
  return result.document;
};
const issuesOf = (doc: CadDocument): string[] => Object.keys(doc.plant?.fabrication?.issues ?? {});
const reviewRequired = (doc: CadDocument): boolean =>
  data<{ reviewRequired: boolean }>(doc, 'export_isometric', { lineId: 'L-101' }).reviewRequired;
const stepOf = (doc: CadDocument, name: string) => doc.featureHistory.find((step) => step.name === name);
const payloadFor = (basisSha256: string, at: string): string =>
  humanGatePayload('plant:issue_isometric', ['L-101'], { revision: 'A', purpose: 'for_construction', basisSha256, at }, 'n1');

describe('issue_isometric: recorded stamp', () => {
  it('stores the host time and the signed payload hash, and the history keeps no signature', () => {
    const doc = issued();
    const issue = Object.values(doc.plant?.fabrication?.issues ?? {})[0];
    expect(issue).toMatchObject({ at: AT, signer: 'alice', signatureId: 'sig-1' });
    expect(issue?.payloadSha256).toBe(payloadFor(issue?.basisSha256 ?? '', AT));
    expect(stepOf(doc, 'issue_isometric')?.params).toMatchObject({ confirmation: { verified: true }, at: AT });
    expect(JSON.stringify(doc.featureHistory)).not.toContain('"nonce"');
  });

  it('the time is part of the signed payload: a signature made for another time does not issue', () => {
    const basis = Object.values(issued().plant?.fabrication?.issues ?? {})[0]?.basisSha256 ?? '';
    const strict: HumanSignaturePort = {
      verify: (_signature, payload) =>
        payload === payloadFor(basis, '2001-01-01T00:00:00Z') ? { signer: 'alice', signatureId: 'sig-1' } : null,
    };
    const numbered = numberedDoc();
    const result = execute(numbered, 'issue_isometric', { ...params, confirmation: { nonce: 'n1' } }, { ...ctx, humanSignature: strict });
    expect(result.error?.code).toBe('ISO_HUMAN_GATE');
    const right = execute(
      numbered,
      'issue_isometric',
      { ...params, at: '2001-01-01T00:00:00Z', confirmation: { nonce: 'n1' } },
      { ...ctx, humanSignature: strict },
    );
    expect(right.error).toBeUndefined();
  });

  it('rejects a missing or malformed at', () => {
    const numbered = numberedDoc();
    for (const at of [undefined, 'yesterday']) {
      const result = execute(numbered, 'issue_isometric', { ...params, at, confirmation: { nonce: 'n1' } }, ctx);
      expect(result.error?.code).toBe('CMD_INVALID_PARAMS');
      expect(result.document).toBe(numbered);
    }
  });

  it('the stored slice (stamp, ledger) is saved and loaded; a malformed ledger or stamp is rejected on load', () => {
    const doc = issued();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.plant?.fabrication?.issueLedger).toEqual(doc.plant?.fabrication?.issueLedger);
    expect(loaded.plant?.fabrication?.issues).toEqual(doc.plant?.fabrication?.issues);
    const slice = JSON.parse(JSON.stringify(doc.plant?.fabrication)) as Record<string, unknown>;
    expect(fabricationErrors(slice)).toEqual([]);
    expect(fabricationErrors({ ...slice, issueLedger: [{ lineId: 'L-101' }] }).length).toBeGreaterThan(0);
    const [id] = issuesOf(doc);
    const stamp = (slice['issues'] as Record<string, Record<string, unknown>>)[id as string];
    expect(fabricationErrors({ ...slice, issues: { [id as string]: { ...stamp, at: 'later' } } }).length).toBeGreaterThan(0);
  });
});

describe('REPLAY and REGENERATE keep a real issue', () => {
  it('REPLAY: replay_history re-applies the recorded step without a signature and the iso stays issued', () => {
    const doc = issued();
    expect(reviewRequired(doc)).toBe(false);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(issuesOf(replayed)).toEqual(issuesOf(doc));
    expect(replayed.plant?.fabrication?.issues).toEqual(doc.plant?.fabrication?.issues);
    expect(replayed.plant?.fabrication?.issueLedger).toEqual(doc.plant?.fabrication?.issueLedger);
    expect(reviewRequired(replayed)).toBe(false);
  });

  it('REGENERATE: editing an earlier step that leaves the content unchanged keeps the issue', () => {
    const doc = issued();
    const define = stepOf(doc, 'define_isometric');
    const edited = execute(
      doc,
      'edit_step_params',
      { stepId: define?.id as string, params: { ...(define?.params as object), paper: 'A2' } },
      ctx,
    );
    expect(edited.rejected, edited.summary).toBeUndefined();
    expect(edited.document.plant?.fabrication?.isometrics?.['L-101']?.paper).toBe('A2');
    expect(issuesOf(edited.document)).toEqual(issuesOf(doc));
    expect(reviewRequired(edited.document)).toBe(false);
  });

  it('the ledger survives a save / load, so the loaded document replays the issue too', () => {
    const loaded = deserializeDocument(serializeDocument(issued()));
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(issuesOf(replayed)).toHaveLength(1);
    expect(reviewRequired(replayed)).toBe(false);
  });
});

describe('a recorded confirmation never issues content no human signed', () => {
  it('a forged { verified: true } on a fresh line is refused (no ledger entry)', () => {
    const numbered = numberedDoc();
    const forged = execute(numbered, 'issue_isometric', { ...params, confirmation: { verified: true } }, ctx);
    expect(forged.error?.code).toBe('ISO_HUMAN_GATE');
    expect(forged.document).toBe(numbered);
  });

  it('a recorded confirmation for another revision or purpose than the ledger holds is refused', () => {
    const doc = issued();
    for (const other of [{ revision: 'B' }, { purpose: 'for_fabrication' }]) {
      const result = execute(
        doc,
        'issue_isometric',
        { ...params, ...other, confirmation: { verified: true } },
        { ...ctx, humanSignature: null },
      );
      expect(result.error?.code).toBe('ISO_HUMAN_GATE');
    }
  });

  it('REGENERATE: an earlier step edit that changes the line content drops the issue (it is not re-applied) and the iso needs review', () => {
    const withWeld = apply(numberedDoc(), 'add_field_weld', { lineId: 'L-101', at: [1000, 0, 3000], type: 'site' });
    const renumbered = apply(withWeld, 'number_welds', { lineId: 'L-101' });
    const doc = execute(renumbered, 'issue_isometric', { ...params, confirmation: { nonce: 'n1' } }, ctx).document;
    expect(issuesOf(doc)).toHaveLength(1);
    const weldStep = stepOf(doc, 'add_field_weld');
    const edited = execute(doc, 'delete_step', { stepId: weldStep?.id as string }, ctx);
    expect(issuesOf(edited.document)).toEqual([]);
    expect(reviewRequired(edited.document)).toBe(true);
  });
});

describe('undo and removal', () => {
  it('undo is the previous document: no issue; deleting the issue step leaves the ledger inert and a replay does not resurrect it', () => {
    const doc = issued();
    const step = stepOf(doc, 'issue_isometric');
    const deleted = execute(doc, 'delete_step', { stepId: step?.id as string }, ctx).document;
    expect(issuesOf(deleted)).toEqual([]);
    expect(deleted.plant?.fabrication?.issueLedger).toHaveLength(1);
    const replayed = execute(deleted, 'replay_history', {}).document;
    expect(issuesOf(replayed)).toEqual([]);
    expect(reviewRequired(replayed)).toBe(true);
  });
});
