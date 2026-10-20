/** Document fixtures for the PLM tests: a managed item driven to a chosen lifecycle state through the real commands. */

import type { CadDocument } from '@core/model/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { loadSample, run } from './scenarioRunner';

export const T = '2026-11-02T09:00:00Z';
export const APPROVALS = [
  { role: 'design-authority', userId: 'u-1' },
  { role: 'checker', userId: 'u-2' },
];

/** The sample document made a managed item (signature requirement off: the test host has no keystore) in state in_work. */
export function inWork(policy: Record<string, unknown> = {}, base: CadDocument = loadSample()): CadDocument {
  return run(base, 'set_item_identity', {
    partNumber: 'LL-2001',
    name: 'Test part',
    itemType: 'part',
    policy: { humanSignatureRequired: false, ...policy },
    at: T,
    by: 'u-1',
  }).document;
}

export const inReview = (policy: Record<string, unknown> = {}): CadDocument =>
  run(inWork(policy), 'submit_for_review', { at: T, by: 'u-1' }).document;

/** In review with an initial-release ECO. */
export function reviewWithEco(policy: Record<string, unknown> = {}): CadDocument {
  return run(inReview(policy), 'create_change_order', {
    id: 'ECO-0100',
    purpose: 'initial-release',
    effectivity: [{ kind: 'serial', from: 1 }],
    at: T,
    by: 'u-1',
  }).document;
}

export const released = (policy: Record<string, unknown> = {}): CadDocument =>
  run(reviewWithEco(policy), 'release_item', { changeOrder: 'ECO-0100', approvals: APPROVALS, at: T, by: 'u-1' }).document;

/** Revision B released (A superseded) through a classified ECO. */
export function releasedB(): CadDocument {
  let doc = released();
  doc = run(doc, 'create_change_order', {
    id: 'ECO-0200',
    classification: 'minor',
    classificationJustification: 'no form-fit-function change',
    effectivity: [{ kind: 'serial', from: 5 }],
    at: T,
    by: 'u-1',
  }).document;
  doc = run(doc, 'revise_item', { changeOrder: 'ECO-0200', at: T, by: 'u-1' }).document;
  doc = run(doc, 'set_parameter', { name: 't', expression: '5' }).document;
  doc = run(doc, 'submit_for_review', { at: T, by: 'u-1' }).document;
  return run(doc, 'release_item', { changeOrder: 'ECO-0200', approvals: APPROVALS, at: T, by: 'u-1' }).document;
}

/** A signature port whose Ed25519 check and trust are scripted by the test. */
export const fakePort = (valid: boolean, trust: 'trusted' | 'untrusted' | 'test' = 'trusted'): HumanSignaturePort => ({
  verify: () => null,
  verifyEd25519: () => valid,
  keyTrust: () => trust,
});
