/** dispose_acoustic_export (VAC-M3): the signed reviewer disposition of an acoustic load package, its re-verification on export, staleness and replay. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import { vibroacousticsErrors } from '@cae/vibroacoustics/model';
import { REVIEW_ACT, reviewDetails } from '@cae/vibroacoustics/review';
import { boxKernel, exposedDocument, refusal } from './boxKernel';
import { run } from './fixtures';

/** A port that verifies a signature only when it names the exact payload it was made over (what a real signature does). */
const port: HumanSignaturePort = {
  verify: (signature, payload) =>
    typeof signature === 'object' && signature !== null && (signature as { signs?: unknown }).signs === payload
      ? { signer: 'rita', signatureId: `sig-${(signature as { nonce: string }).nonce}` }
      : null,
};
const context = (humanSignature: HumanSignaturePort | null, extra: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...defaultContext(),
  kernel: boxKernel(),
  humanSignature,
  ...extra,
});
const signing = context(port);
const unsigned = context(null);

const EXPOSURE = 'enclosure_skin';
const JUSTIFICATION = 'review record VAC-RR-12: spectrum per launch-vehicle guide, faces checked';

interface Review {
  status: string;
  fingerprint: string;
  signer?: string;
  unconfirmed?: string;
}
interface Package {
  review: Review;
  items: { code: string; message: string }[];
  provenance: { llullVersion: string | null };
  reviewRequired: boolean;
}

const exported = (doc: CadDocument, ctx: ExecutionContext = signing): Package => {
  const result = execute(doc, 'export_acoustic_load', { exposure: EXPOSURE }, ctx);
  expect(result.rejected, result.summary).not.toBe(true);
  return result.data as Package;
};
const fingerprintOf = (doc: CadDocument): string => exported(doc).review.fingerprint;

/** The signature a human holds for exactly this decision on this exposure of this document. */
const signature = (doc: CadDocument, decision = 'accepted', nonce = 'n1', exposure = EXPOSURE): { nonce: string; signs: string } => ({
  nonce,
  signs: humanGatePayload(REVIEW_ACT, [exposure], reviewDetails(decision, JUSTIFICATION, fingerprintOf(doc), doc.uid ?? ''), nonce),
});

const dispose = (doc: CadDocument, params: Record<string, unknown>, ctx: ExecutionContext = signing): CommandResult =>
  execute(doc, 'dispose_acoustic_export', { exposure: EXPOSURE, decision: 'accepted', justification: JUSTIFICATION, ...params }, ctx);

const accepted = (): { doc: CadDocument; before: CadDocument; box: string } => {
  const { doc, box } = exposedDocument();
  const result = dispose(doc, { confirmation: signature(doc) });
  expect(result.error, result.summary).toBeUndefined();
  return { doc: result.document, before: doc, box };
};

const codes = (data: Package): string[] => data.items.map((item) => item.code);

describe('dispose_acoustic_export: the human gate', () => {
  it.each([
    ['no signing port (an agent)', unsigned, { confirmation: { nonce: 'n1' } }],
    ['a port but no confirmation', signing, {}],
    ['a bare true from an agent', signing, { confirmation: true }],
    ['a signature that does not verify', signing, { confirmation: { nonce: 'n1', signs: 'forged' } }],
    ['a signature without a nonce', signing, { confirmation: { signs: 'x' } }],
  ])('%s -> VAC_HUMAN_GATE and the document is unchanged', (_label, ctx, extra) => {
    const { doc } = exposedDocument();
    const result = dispose(doc, extra, ctx);
    expect(refusal(result)).toBe('VAC_HUMAN_GATE');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('a signature for another decision, another exposure or another document does not verify', () => {
    const { doc } = exposedDocument();
    expect(refusal(dispose(doc, { decision: 'rejected', confirmation: signature(doc, 'accepted') }))).toBe('VAC_HUMAN_GATE');
    expect(refusal(dispose(doc, { confirmation: signature(doc, 'accepted', 'n1', 'other') }))).toBe('VAC_HUMAN_GATE');
    expect(refusal(dispose({ ...doc, uid: '0'.repeat(32) }, { confirmation: signature(doc) }))).toBe('VAC_HUMAN_GATE');
  });

  it('records the disposition; the export then carries no VAC_REVIEW_PENDING, names the signer and keeps every number', () => {
    const { doc, before } = accepted();
    const review = doc.vibroacoustics?.reviews?.[EXPOSURE];
    expect(review).toMatchObject({
      exposure: EXPOSURE,
      decision: 'accepted',
      signer: 'rita',
      signatureId: 'sig-n1',
      documentUid: before.uid,
    });
    expect(vibroacousticsErrors({ vibroacoustics: doc.vibroacoustics })).toEqual([]);
    const after = exported(doc);
    expect(codes(after)).toEqual([]);
    expect(after.review).toMatchObject({ status: 'accepted', signer: 'rita', fingerprint: fingerprintOf(before) });
    expect(after.reviewRequired).toBe(true);
    const { review: _after, items: _afterItems, ...afterNumbers } = after as unknown as Record<string, unknown>;
    const { review: _before, items: _beforeItems, ...beforeNumbers } = exported(before) as unknown as Record<string, unknown>;
    expect({ ...afterNumbers, provenance: null }).toEqual({ ...beforeNumbers, provenance: null });
    expect(codes(exported(before))).toEqual(['VAC_REVIEW_PENDING']);
    expect(exported(before).review.status).toBe('none');
  });

  it('a rejected package carries VAC_REVIEW_REJECTED with the justification', () => {
    const { doc } = exposedDocument();
    const rejected = dispose(doc, { decision: 'rejected', confirmation: signature(doc, 'rejected') }).document;
    const data = exported(rejected);
    expect(data.review.status).toBe('rejected');
    expect(codes(data)).toEqual(['VAC_REVIEW_REJECTED']);
    expect(data.items[0]?.message).toContain('VAC-RR-12');
  });

  it('without a port, in a copy (other uid) or as a forged record the disposition is unconfirmed and VAC_REVIEW_PENDING stays', () => {
    const { doc } = accepted();
    const noPort = exported(doc, unsigned);
    expect(noPort.review).toMatchObject({ status: 'unconfirmed', unconfirmed: 'noport' });
    expect(codes(noPort)).toEqual(['VAC_REVIEW_PENDING']);
    expect(exported({ ...doc, uid: 'f'.repeat(32) }).review).toMatchObject({ status: 'unconfirmed', unconfirmed: 'foreign' });
    const stored = doc.vibroacoustics?.reviews?.[EXPOSURE];
    const forged = {
      ...doc,
      vibroacoustics: { ...doc.vibroacoustics, reviews: { [EXPOSURE]: { ...stored, justification: 'edited' } } },
    } as CadDocument;
    expect(exported(forged).review).toMatchObject({ status: 'unconfirmed', unconfirmed: 'invalid' });
  });

  it('goes stale when the target solid moves (fingerprint changes), not when it is only recoloured', () => {
    const { doc, box } = accepted();
    const moved = run(doc, 'move_entities', { ids: [box], delta: [0, 0, 5] }).document;
    const data = exported(moved);
    expect(data.review.status).toBe('stale');
    expect(data.review.fingerprint).not.toBe(fingerprintOf(doc));
    expect(codes(data)).toEqual(['VAC_REVIEW_PENDING']);
    expect(data.items[0]?.message).toContain('no longer applies');
    const recoloured = run(doc, 'set_entity_color', { entityIds: [box], color: '#112233' }).document;
    expect(exported(recoloured).review.status).toBe('accepted');
  });

  it('deleting the exposure drops its disposition', () => {
    const { doc } = accepted();
    const deleted = run(doc, 'delete_acoustic_exposure', { name: EXPOSURE }).document;
    expect(deleted.vibroacoustics?.reviews).toBeUndefined();
  });

  it('refuses a blank justification, an unknown exposure, a lost target and a document without uid', () => {
    const { doc, box } = exposedDocument();
    const confirmation = signature(doc);
    expect(refusal(dispose(doc, { justification: '  ', confirmation }))).toBe('VAC_PARAMS_INVALID');
    expect(refusal(dispose(doc, { exposure: 'nope', confirmation }))).toBe('VAC_EXPOSURE_UNKNOWN');
    expect(refusal(dispose(doc, { exposure: 'constructor', confirmation }))).toBe('VAC_EXPOSURE_UNKNOWN');
    const lost = run(doc, 'delete_entities', { ids: [box] }).document;
    expect(refusal(dispose(lost, { confirmation }))).toBe('VAC_EXPOSURE_UNRESOLVED');
    const { uid: _uid, ...noUid } = doc;
    expect(refusal(dispose(noUid as CadDocument, { confirmation }))).toBe('VAC_DOCUMENT_UNIDENTIFIED');
    const { vibroacoustics: slice } = doc;
    const orphan = { ...doc, vibroacoustics: { ...slice, spectra: {}, spectrumOrder: [] } } as CadDocument;
    expect(refusal(dispose(orphan, { confirmation }))).toBe('VAC_SPECTRUM_UNKNOWN');
  });

  it('is pure, and a spent signature is not honoured twice', () => {
    const { doc } = exposedDocument();
    const before = structuredClone(doc);
    const confirmation = signature(doc);
    const spent = new Set<string>();
    const once = context({ ...port, spend: (_signature, payload) => (spent.has(payload) ? false : (spent.add(payload), true)) });
    expect(dispose(doc, { confirmation }, once).error).toBeUndefined();
    expect(doc).toEqual(before);
    expect(refusal(dispose(doc, { confirmation }, once))).toBe('VAC_HUMAN_GATE');
  });

  it('refuses a malformed stored review on load', () => {
    const { doc } = accepted();
    const slice = doc.vibroacoustics;
    const review = slice?.reviews?.[EXPOSURE];
    expect(vibroacousticsErrors({ vibroacoustics: { ...slice, reviews: { other: review } } }).join()).toContain(
      "must equal its key 'other'",
    );
    expect(vibroacousticsErrors({ vibroacoustics: { ...slice, reviews: { [EXPOSURE]: { ...review, fingerprint: 'x' } } } })).not.toEqual(
      [],
    );
  });
});

describe('dispose_acoustic_export: history replay', () => {
  const replay = { ...signing, replaying: true } as ExecutionContext;

  it('re-applies a recorded step only from the disposition a human signed in this document', () => {
    const { doc } = accepted();
    const again = dispose(doc, { confirmation: { verified: true } }, replay);
    expect(again.error).toBeUndefined();
    expect(again.summary).toContain('replayed');
    expect(again.document).toBe(doc);
  });

  it('refuses a forged replayed step, one whose decision differs and a kept record whose signature fails', () => {
    const { doc, before } = accepted();
    expect(refusal(dispose(before, { confirmation: { verified: true } }, replay))).toBe('VAC_HUMAN_GATE');
    expect(refusal(dispose(doc, { decision: 'rejected', confirmation: { verified: true } }, replay))).toBe('VAC_HUMAN_GATE');
    const rejecting = { ...replay, humanSignature: { verify: () => null } } as ExecutionContext;
    expect(refusal(dispose(doc, { confirmation: { verified: true } }, rejecting))).toBe('VAC_HUMAN_GATE');
  });

  it('with no port a replay trusts the kept record for the replay only; the export then reports it unconfirmed', () => {
    const { doc } = accepted();
    const noPortReplay = { ...unsigned, replaying: true } as ExecutionContext;
    expect(dispose(doc, { confirmation: { verified: true } }, noPortReplay).document).toBe(doc);
    expect(exported(doc, unsigned).review.status).toBe('unconfirmed');
  });

  it('the history records { verified: true } and replay_history keeps the accepted disposition', () => {
    const { doc } = accepted();
    const step = doc.featureHistory.at(-1);
    expect(step?.name).toBe('dispose_acoustic_export');
    expect((step?.params as { confirmation: unknown }).confirmation).toEqual({ verified: true });
    const replayed = execute(doc, 'replay_history', {}, signing);
    expect(replayed.summary).not.toMatch(/refused|failed/i);
    expect(replayed.document.vibroacoustics?.reviews).toEqual(doc.vibroacoustics?.reviews);
    expect(exported(replayed.document).review.status).toBe('accepted');
  });

  it('the plugin replay seed keeps the reviews and nothing else', async () => {
    const { vibroacousticsPlugin } = await import('@cae/vibroacoustics/plugin');
    const { doc, before } = accepted();
    expect(vibroacousticsPlugin.document?.replaySeed?.(doc)).toEqual({
      vibroacoustics: { spectra: {}, spectrumOrder: [], exposures: {}, exposureOrder: [], reviews: doc.vibroacoustics?.reviews },
    });
    expect(vibroacousticsPlugin.document?.replaySeed?.(before)).toEqual({});
  });
});

describe('export_acoustic_load: host-stamped llullVersion', () => {
  it('carries ctx.hostVersion, and null without a host', () => {
    const { doc } = exposedDocument();
    expect(exported(doc, context(port, { hostVersion: '9.8.7' })).provenance.llullVersion).toBe('9.8.7');
    expect(exported(doc).provenance.llullVersion).toBeNull();
  });
});
