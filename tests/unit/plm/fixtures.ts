/** Document fixtures for the PLM tests: a managed item driven to a chosen lifecycle state through the real commands (each human act signed by its user). */

import type { CadDocument } from '@core/model/types';
import { loadSample, run } from './scenarioRunner';

export const T = '2026-11-02T09:00:00Z';
export const APPROVALS = [
  { role: 'design-authority', userId: 'u-1' },
  { role: 'checker', userId: 'u-2' },
];

/** Record every approval of `APPROVALS`, each signed by its own approver. */
export const approveAll = (doc: CadDocument): CadDocument =>
  APPROVALS.reduce((next, approval) => run(next, 'record_approval', approval).document, doc);

/** The sample document made a managed item (signature requirement off by a signed policy override: the test host has no key store) in state in_work. */
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
  run(approveAll(reviewWithEco(policy)), 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;

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
  return run(approveAll(doc), 'release_item', { changeOrder: 'ECO-0200', at: T, by: 'u-1' }).document;
}
