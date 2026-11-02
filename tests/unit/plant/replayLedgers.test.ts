/** Replay keeps every plugin ledger (approve_pipe_spec AND issue_isometric), and a recorded confirmation is honoured only while replaying. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply } from '../../helpers/commandAssertions';
import { AT, issueParams, signedPlantDoc, signingContext } from '../../helpers/signedPlantDoc';
import { loadedL101 } from './fabrication/isoM2Fixtures';

const specStatus = (doc: CadDocument): string | undefined => doc.plant?.spec?.specs['CS150-A1']?.[0]?.status;
const issueCount = (doc: CadDocument): number => Object.keys(doc.plant?.fabrication?.issues ?? {}).length;
const stepId = (doc: CadDocument, name: string): string => doc.featureHistory.find((step) => step.name === name)?.id as string;

describe('two plugins seed the same top-level key (plant) on replay', () => {
  it('replay_history keeps the spec approval AND the isometric issue', () => {
    const doc = signedPlantDoc();
    expect(specStatus(doc)).toBe('approved');
    expect(issueCount(doc)).toBe(1);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(specStatus(replayed)).toBe('approved');
    expect(issueCount(replayed)).toBe(1);
    expect(replayed.plant?.spec?.approvals).toEqual(doc.plant?.spec?.approvals);
    expect(replayed.plant?.fabrication?.issueLedger).toEqual(doc.plant?.fabrication?.issueLedger);
  });

  it('regeneration (a step edit) keeps both', () => {
    const doc = signedPlantDoc();
    const welds = doc.featureHistory.find((step) => step.name === 'number_welds');
    const edited = execute(
      doc,
      'edit_step_params',
      { stepId: welds?.id as string, params: { ...(welds?.params as object) } },
      signingContext,
    );
    expect(edited.rejected, edited.summary).toBeUndefined();
    expect(specStatus(edited.document)).toBe('approved');
    expect(issueCount(edited.document)).toBe(1);
  });
});

describe('a recorded { verified: true } is honoured by replay only', () => {
  it('issue_isometric: sign, delete the step, a direct call with { verified: true } is ISO_HUMAN_GATE (the ledger still holds the entry)', () => {
    const doc = signedPlantDoc();
    const deleted = execute(doc, 'delete_step', { stepId: stepId(doc, 'issue_isometric') }, signingContext).document;
    expect(issueCount(deleted)).toBe(0);
    expect(deleted.plant?.fabrication?.issueLedger).toHaveLength(1);
    for (const ctx of [signingContext, undefined]) {
      const direct = execute(deleted, 'issue_isometric', { ...issueParams, confirmation: { verified: true } }, ctx);
      expect(direct.error?.code).toBe('ISO_HUMAN_GATE');
      expect(direct.document).toBe(deleted);
    }
  });

  it('approve_pipe_spec: sign, delete the step, a direct call with { verified: true } is PSC_HUMAN_GATE', () => {
    const doc = signedPlantDoc();
    const deleted = execute(doc, 'delete_step', { stepId: stepId(doc, 'approve_pipe_spec') }, signingContext).document;
    expect(specStatus(deleted)).toBe('draft');
    const direct = execute(deleted, 'approve_pipe_spec', { specId: 'CS150-A1', at: AT, confirmation: { verified: true } }, signingContext);
    expect(direct.error?.code).toBe('PSC_HUMAN_GATE');
    expect(specStatus(direct.document)).toBe('draft');
  });

  it('a build_project plan: live it needs a signature; recorded and replayed it re-applies the issue (the flag reaches the nested execute)', () => {
    const numbered = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
    const plan = (confirmation: unknown): { actions: unknown[] } => ({
      actions: [{ command: 'issue_isometric', params: { ...issueParams, confirmation } }],
    });
    const unsigned = execute(numbered, 'build_project', plan({ verified: true }), signingContext);
    expect(issueCount(unsigned.document)).toBe(0);
    const signed = execute(numbered, 'build_project', plan({ nonce: 'n' }), signingContext);
    expect(issueCount(signed.document)).toBe(1);
    const replayed = execute(signed.document, 'replay_history', {}).document;
    expect(issueCount(replayed)).toBe(1);
  });

  it('the recorded path validates at: the recorded step re-runs the schema: an impossible date is refused and the history is unchanged', () => {
    const doc = signedPlantDoc();
    const step = doc.featureHistory.find((entry) => entry.name === 'issue_isometric');
    const edited = execute(
      doc,
      'edit_step_params',
      { stepId: step?.id as string, params: { ...(step?.params as object), at: '2026-02-31T23:00:00Z' } },
      signingContext,
    );
    expect(edited.summary).toContain('naming a real date and time');
    expect(edited.document).toBe(doc);
  });
});
