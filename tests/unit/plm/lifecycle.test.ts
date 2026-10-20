import { describe, expect, it } from 'vitest';
import { type ScenarioStep, loadSample, readValidation, run, runStep } from './scenarioRunner';
import { agentContext } from './scenarioRunner';
import { sha256Hex } from '@lib/sha256';

interface Scenario {
  readonly steps: ScenarioStep[];
}
const s1 = JSON.parse(readValidation('scenarios/S1_release_eco_revB.json')) as Scenario;
const vectors = JSON.parse(readValidation('vectors/hash_vectors.json')) as { sample_document: Record<string, string> };

/** The test host has no signing keystore, so the signature requirement is switched off by a human policy override (set_item_identity). */
const options = {
  rename: { set_export_marking: 'set_item_marking' },
  patch: (step: ScenarioStep) =>
    step.command === 'set_item_identity' ? { ...step.params, policy: { humanSignatureRequired: false } } : step.params,
};

describe('S1 release A, ECR -> ECO -> revision B (VC-PLM-01..07, 12)', () => {
  it('runs every step with the expected states', () => {
    let doc = loadSample();
    for (const step of s1.steps) doc = runStep(doc, step, options);
    const item = doc.plm?.item;
    expect(item?.currentRevision).toBe('B');
    expect(item?.revisions['A']?.state).toBe('superseded');
    expect(item?.revisions['B']?.state).toBe('released');
    expect(item?.revisionOrder).toEqual(['A', 'B']);
  });

  it('freezes revision A at the published golden content hash', () => {
    let doc = loadSample();
    for (const step of s1.steps.filter((candidate) => (candidate.n ?? 0) <= 7)) doc = runStep(doc, step, options);
    const released = doc.plm?.item.revisions['A'];
    expect(released?.contentHash).toBe(vectors.sample_document['release_scope_canonical_sha256']);
    expect(sha256Hex(released?.snapshot?.canonicalJson ?? '')).toBe(released?.contentHash);
  });

  it('is deterministic: replaying the same plan reproduces identical plm state', () => {
    const play = (): unknown => {
      let doc = loadSample();
      for (const step of s1.steps) doc = runStep(doc, step, options);
      return doc.plm;
    };
    expect(play()).toEqual(play());
  });

  it('keeps plm across replay_history (carry hook, TR-PLM-32)', () => {
    let doc = loadSample();
    for (const step of s1.steps.filter((candidate) => (candidate.n ?? 0) <= 12)) doc = runStep(doc, step, options);
    const replayed = run(doc, 'replay_history', {}).document;
    expect(replayed.plm).toBe(doc.plm);
  });

  it('an agent prepares but cannot approve or release (VC-PLM-26)', () => {
    let doc = loadSample();
    const as = agentContext();
    doc = run(doc, 'set_item_identity', { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part' }, as).document;
    expect(doc.plm?.item.revisions['A']?.state).toBe('in_work');
    doc = run(doc, 'submit_for_review', { at: '2026-11-01T10:00:00Z', by: 'agent' }, as).document;
    expect(doc.plm?.item.revisions['A']?.state).toBe('in_review');
    for (const [command, params] of [
      ['record_approval', { role: 'checker', userId: 'u-2' }],
      ['release_item', { at: '2026-11-02T09:00:00Z', by: 'agent' }],
      ['create_change_order', { classification: 'minor' }],
      ['set_item_marking', { regime: 'none', decidedBy: 'u-3' }],
    ] as const) {
      const refused = run(doc, command, params, as);
      expect(refused.error?.code, command).toBe('PLM_HUMAN_GATE');
      expect(refused.document, command).toBe(doc);
    }
    const status = run(doc, 'plm_status', {}, as).data as { nextHumanAction: string };
    expect(status.nextHumanAction).toContain('record_approval');
  });
});
