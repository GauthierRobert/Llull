import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import { DISPOSE_ACT, dispositionDetails } from '@cae/electroOptical/gate';
import { checkBonding, run, runPlan } from './fixtures';

/** A port that verifies a signature only when it names the exact payload it was made over (what a real signature does). */
const port: HumanSignaturePort = {
  verify: (signature, payload) =>
    typeof signature === 'object' && signature !== null && (signature as { signs?: unknown }).signs === payload
      ? { signer: 'alice', signatureId: `sig-${(signature as { nonce: string }).nonce}` }
      : null,
};
const signing: ExecutionContext = { ...defaultContext(), humanSignature: port };
const unsigned: ExecutionContext = { ...defaultContext(), humanSignature: null };

const base = (): { doc: CadDocument; p1: string; p2: string; box: string; hash: string } => {
  const { doc, aliases } = runPlan('eop_bonding_paths.plan.json', 'check_bonding');
  const failing = checkBonding(doc).rows.find((row) => row.status === 'fail');
  return { doc, p1: aliases['p1'] ?? '', p2: aliases['p2'] ?? '', box: aliases['box'] ?? '', hash: failing?.inputsHash ?? '' };
};

const JUSTIFICATION = 'degraded joint accepted for the prototype only, retest planned';

/** The signature a human holds for exactly this decision on this path of this document. */
const signature = (
  doc: CadDocument,
  pathId: string,
  hash: string,
  decision = 'accepted',
  nonce = 'n1',
): { nonce: string; signs: string } => ({
  nonce,
  signs: humanGatePayload(DISPOSE_ACT, [pathId], dispositionDetails(decision, JUSTIFICATION, hash, doc.uid ?? ''), nonce),
});

const dispose = (doc: CadDocument, params: Record<string, unknown>, ctx: ExecutionContext = signing): CommandResult =>
  execute(doc, 'dispose_bond_check', { decision: 'accepted', justification: JUSTIFICATION, ...params }, ctx);

describe('dispose_bond_check: the human gate (AC-7, VC-EOP-12)', () => {
  it.each([
    ['no signing port (an agent)', unsigned, { confirmation: { nonce: 'n1' } }],
    ['a port but no confirmation', signing, {}],
    ['a bare true from an agent', signing, { confirmation: true }],
    ['a signature that does not verify', signing, { confirmation: { nonce: 'n1', signs: 'forged' } }],
    ['a signature without a nonce', signing, { confirmation: { signs: 'x' } }],
  ])('%s -> EOP_HUMAN_GATE and the document is unchanged', (_label, ctx, extra) => {
    const { doc, p2 } = base();
    const result = dispose(doc, { pathId: p2, ...extra }, ctx);
    expect(result.error?.code).toBe('EOP_HUMAN_GATE');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('a signature made for another decision does not verify for this one', () => {
    const { doc, p2, hash } = base();
    const result = dispose(doc, { pathId: p2, decision: 'rejected', confirmation: signature(doc, p2, hash, 'accepted') });
    expect(result.error?.code).toBe('EOP_HUMAN_GATE');
  });

  it('a signature made for another path or another document does not verify', () => {
    const { doc, p2, hash } = base();
    expect(dispose(doc, { pathId: p2, confirmation: signature(doc, 'bp-other', hash) }).error?.code).toBe('EOP_HUMAN_GATE');
    expect(dispose({ ...doc, uid: '0'.repeat(32) }, { pathId: p2, confirmation: signature(doc, p2, hash) }).error?.code).toBe(
      'EOP_HUMAN_GATE',
    );
  });

  it('records the decision with signer, hash and uid; the row keeps its status and the overall status ignores an accepted path', () => {
    const { doc, p2, hash } = base();
    const result = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([p2]);
    expect(result.document.electroOptical?.dispositions[p2]).toMatchObject({
      decision: 'accepted',
      signer: 'alice',
      inputsHash: hash,
      documentUid: doc.uid,
    });
    const after = checkBonding(result.document, {}, signing);
    expect(after.rows.find((row) => row.pathId === p2)).toMatchObject({ status: 'fail', disposition: 'accepted' });
    expect(after.status).toBe('pass');
    expect(after.open).toEqual([]);
    expect(checkBonding(doc).status).toBe('fail');
  });

  it('a rejected or redesign decision is recorded but the path stays open', () => {
    const { doc, p2, hash } = base();
    const rejected = dispose(doc, { pathId: p2, decision: 'redesign', confirmation: signature(doc, p2, hash, 'redesign') });
    const after = checkBonding(rejected.document, {}, signing);
    expect(after.rows.find((row) => row.pathId === p2)?.disposition).toBe('redesign');
    expect(after.status).toBe('fail');
  });

  it('without a port a stored disposition is not confirmed (unconfirmed) and counts for nothing', () => {
    const { doc, p2, hash } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const after = checkBonding(accepted, {}, unsigned);
    expect(after.rows.find((row) => row.pathId === p2)?.disposition).toBe('unconfirmed');
    expect(after.status).toBe('fail');
  });

  it('a record copied into another document (other uid) is unconfirmed', () => {
    const { doc, p2, hash } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const copy = { ...accepted, uid: 'f'.repeat(32) };
    expect(checkBonding(copy, {}, signing).rows.find((row) => row.pathId === p2)?.disposition).toBe('unconfirmed');
  });

  it('a forged record that holds no verifying signature is unconfirmed', () => {
    const { doc, p2, hash } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const stored = accepted.electroOptical?.dispositions[p2];
    const forged = {
      ...accepted,
      electroOptical: { ...accepted.electroOptical, dispositions: { [p2]: { ...stored, justification: 'edited' } } },
    } as CadDocument;
    expect(checkBonding(forged, {}, signing).rows.find((row) => row.pathId === p2)?.disposition).toBe('unconfirmed');
  });

  it('goes stale when the path changes after the signature (hash differs)', () => {
    const { doc, p2, hash, box } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const changed = run(
      run(accepted, 'define_material_record', {
        id: 'anod',
        designation: 't',
        productForm: 'coating',
        specs: [],
        licence: 'company-proprietary',
        exportMarking: { regime: 'none' },
      }),
      'assign_surface_coating',
      { entityId: box, coating: 'anod', location: 'bonded_interface', electrical: 'unknown' },
    );
    const row = checkBonding(changed, {}, signing).rows.find((item) => item.pathId === p2);
    expect(row?.inputsHash).not.toBe(hash);
    expect(row?.disposition).toBe('stale');
  });

  it('refuses a passing path, an unknown path, a blank justification and a document without uid', () => {
    const { doc, p1, p2, hash } = base();
    expect(dispose(doc, { pathId: p1, confirmation: { nonce: 'n1' } }).error?.code).toBe('EOP_NOTHING_TO_DISPOSE');
    expect(dispose(doc, { pathId: 'bp-none', confirmation: { nonce: 'n1' } }).error?.code).toBe('EOP_PATH_NOT_FOUND');
    expect(dispose(doc, { pathId: p2, justification: ' ', confirmation: signature(doc, p2, hash) }).error?.code).toBe('EOP_PARAMS_INVALID');
    const { uid: _uid, ...noUid } = doc;
    expect(dispose(noUid as CadDocument, { pathId: p2, confirmation: signature(doc, p2, hash) }).error?.code).toBe(
      'EOP_DOCUMENT_UNIDENTIFIED',
    );
  });

  it('is pure', () => {
    const { doc, p2, hash } = base();
    const before = structuredClone(doc);
    dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) });
    expect(doc).toEqual(before);
  });

  it('a spent signature is not honoured twice', () => {
    const { doc, p2, hash } = base();
    const spent = new Set<string>();
    const once: HumanSignaturePort = { ...port, spend: (_signature, payload) => (spent.has(payload) ? false : (spent.add(payload), true)) };
    const ctx: ExecutionContext = { ...defaultContext(), humanSignature: once };
    const confirmation = signature(doc, p2, hash);
    expect(dispose(doc, { pathId: p2, confirmation }, ctx).error).toBeUndefined();
    expect(dispose(doc, { pathId: p2, confirmation }, ctx).error?.code).toBe('EOP_HUMAN_GATE');
  });
});

describe('dispose_bond_check: history replay', () => {
  const replay = { ...signing, replaying: true } as ExecutionContext;

  it('re-applies a recorded step only from the disposition a human signed in this document', () => {
    const { doc, p2, hash } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const again = dispose(accepted, { pathId: p2, confirmation: { verified: true } }, replay);
    expect(again.error).toBeUndefined();
    expect(again.summary).toContain('replayed');
    expect(again.document).toBe(accepted);
  });

  it('refuses a forged replayed step (no signed record) and one whose decision differs', () => {
    const { doc, p2, hash } = base();
    expect(dispose(doc, { pathId: p2, confirmation: { verified: true } }, replay).error?.code).toBe('EOP_HUMAN_GATE');
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    expect(dispose(accepted, { pathId: p2, decision: 'rejected', confirmation: { verified: true } }, replay).error?.code).toBe(
      'EOP_HUMAN_GATE',
    );
  });

  it('the plugin replay seed keeps the dispositions and drops the rest', async () => {
    const { electroOpticalPlugin } = await import('@cae/electroOptical/plugin');
    const { doc, p2, hash } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const seed = electroOpticalPlugin.document?.replaySeed?.(accepted);
    expect(seed).toEqual({ electroOptical: { coatings: {}, bondPaths: {}, dispositions: accepted.electroOptical?.dispositions } });
    expect(electroOpticalPlugin.document?.replaySeed?.(doc)).toEqual({});
  });
});

describe('stored dispositions and a port that fails', () => {
  it('a port that throws on a hostile signature has not confirmed it: unconfirmed, never a crash', () => {
    const { doc, p2, hash } = base();
    const accepted = dispose(doc, { pathId: p2, confirmation: signature(doc, p2, hash) }).document;
    const throwing: HumanSignaturePort = {
      verify: () => {
        throw new Error('hostile signature');
      },
    };
    const row = checkBonding(accepted, {}, { ...defaultContext(), humanSignature: throwing }).rows.find((item) => item.pathId === p2);
    expect(row?.disposition).toBe('unconfirmed');
  });

  it('deleting a path frees its solid: the guard no longer holds it', () => {
    const { doc, p1, p2, box } = base();
    const blocked = execute(doc, 'delete_entities', { ids: [box] });
    expect(blocked.summary).toContain('is used by');
    const withoutPaths = run(run(doc, 'delete_bond_path', { pathId: p1 }), 'delete_bond_path', { pathId: p2 });
    const deleted = execute(withoutPaths, 'delete_entities', { ids: [box] });
    expect(deleted.error).toBeUndefined();
    expect(deleted.document.entities[box]).toBeUndefined();
  });
});
