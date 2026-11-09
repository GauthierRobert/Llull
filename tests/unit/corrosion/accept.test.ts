import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { signingContext } from '../../helpers/signedPlantDoc';
import { check, pair, run, withEnvironment } from './fixtures';

/** The failing couple of the validation plan: 7075 plate with a titanium block, normal environment (item galvanic:<plate>|<block>). */
function failing(): { doc: CadDocument; key: string } {
  const { doc, plate, block } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
  return { doc: withEnvironment(doc, 'normal'), key: `galvanic:${plate}|${block}` };
}

const accept = (doc: CadDocument, key: string, extra: Record<string, unknown> = {}, ctx = signingContext): ReturnType<typeof execute> =>
  execute(
    doc,
    'accept_corrosion_item',
    { itemKey: key, decision: 'accepted', justification: 'sealed with MIL-PRF-81733 per drawing note 4', ...extra },
    ctx,
  );

describe('accept_corrosion_item: the human gate (VC-COR-15)', () => {
  it.each([
    ['no signing port (an agent)', null, { confirmation: { nonce: 'n' } }],
    ['a port but no confirmation', signingContext, {}],
    ['a bare true from an agent', signingContext, { confirmation: true }],
    ['a signature without a nonce', signingContext, { confirmation: { signature: 'x' } }],
  ])('%s -> COR_HUMAN_GATE and the document is unchanged', (_label, ctx, extra) => {
    const { doc, key } = failing();
    const result = accept(doc, key, extra, ctx ?? { ...defaultContext(), humanSignature: null });
    expect(result.error?.code).toBe('COR_HUMAN_GATE');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('a signature the port rejects is COR_HUMAN_GATE and is not spent', () => {
    const { doc, key } = failing();
    let spent = 0;
    const port: HumanSignaturePort = { verify: () => null, spend: () => (spent++, true) };
    expect(accept(doc, key, { confirmation: { nonce: 'n' } }, { ...defaultContext(), humanSignature: port }).error?.code).toBe(
      'COR_HUMAN_GATE',
    );
    expect(spent).toBe(0);
  });

  it('records the decision with signer, fingerprint and uid; the item keeps its status and the overall status ignores an accepted item', () => {
    const { doc, key } = failing();
    const result = accept(doc, key, { confirmation: { nonce: 'n1' } });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([key]);
    expect(result.document.corrosion?.acceptances[key]).toMatchObject({
      decision: 'accepted',
      signer: 'alice',
      signatureId: 'sig-1',
      documentUid: doc.uid,
    });
    const after = check(result.document, {}, signingContext);
    expect(after.items[0]).toMatchObject({ status: 'fail', acceptance: { decision: 'accepted', signer: 'alice' } });
    expect(after.status).toBe('pass');
    expect(after.counts['accepted']).toBe(1);
    expect(check(doc).status).toBe('fail');
  });

  it('a rejected decision is recorded but still counts against the status', () => {
    const { doc, key } = failing();
    const result = accept(doc, key, { decision: 'rejected', confirmation: { nonce: 'n1' } });
    expect(check(result.document, {}, signingContext).items[0]?.acceptance?.decision).toBe('rejected');
    expect(check(result.document, {}, signingContext).status).toBe('fail');
  });

  it('the acceptance ends when the finding changes (another environment): staleAcceptance, status back to fail', () => {
    const { doc, key } = failing();
    const accepted = accept(doc, key, { confirmation: { nonce: 'n1' } }).document;
    const changed = run(accepted, 'set_service_environment', { scheme: 'anodic_index', environment: 'harsh' });
    const item = check(changed, {}, signingContext).items[0];
    expect(item?.acceptance).toBeUndefined();
    expect(item?.staleAcceptance).toBe(true);
    expect(check(changed, {}, signingContext).status).toBe('fail');
  });

  it('the signed payload binds the item, decision, justification, finding and document', () => {
    const { doc, key } = failing();
    const payloads: string[] = [];
    const recording: HumanSignaturePort = { verify: (_signature, payload) => (payloads.push(payload), null) };
    const ctx = { ...defaultContext(), humanSignature: recording };
    accept(doc, key, { confirmation: { nonce: 'n' } }, ctx);
    accept(doc, key, { confirmation: { nonce: 'n' }, decision: 'rejected' }, ctx);
    accept(doc, key, { confirmation: { nonce: 'n' }, justification: 'another reason' }, ctx);
    accept(doc, key, { confirmation: { nonce: 'm' } }, ctx);
    accept(
      run(doc, 'set_service_environment', { scheme: 'anodic_index', environment: 'harsh' }),
      key,
      { confirmation: { nonce: 'n' } },
      ctx,
    );
    expect(payloads).toHaveLength(5);
    expect(new Set(payloads).size).toBe(5);
    const strict: HumanSignaturePort = {
      verify: (_signature, payload) => (payload === payloads[0] ? { signer: 'bob', signatureId: 's9' } : null),
    };
    const strictCtx = { ...defaultContext(), humanSignature: strict };
    expect(accept(doc, key, { confirmation: { nonce: 'n' } }, strictCtx).document.corrosion?.acceptances[key]?.signer).toBe('bob');
    expect(accept(doc, key, { confirmation: { nonce: 'n' }, justification: 'tampered' }, strictCtx).error?.code).toBe('COR_HUMAN_GATE');
  });

  it('refuses a missing item, a passing item, a blank justification and a document without uid', () => {
    const { doc, key } = failing();
    const confirmation = { nonce: 'n' };
    expect(accept(doc, 'galvanic:a|b', { confirmation }).error?.code).toBe('COR_ITEM_NOT_FOUND');
    expect(accept(doc, key, { confirmation, justification: '  ' }).error?.code).toBe('COR_PARAMS_INVALID');
    expect(accept({ ...doc, uid: undefined } as never, key, { confirmation }).error?.code).toBe('COR_DOCUMENT_UNIDENTIFIED');
    const fine = pair(['aluminium_wrought_other', 'aluminium_wrought_other']);
    const passing = withEnvironment(fine.doc, 'normal');
    expect(check(passing).items[0]?.status).not.toBe('fail');
    const ok = check(passing).items[0];
    if (ok?.status === 'pass') expect(accept(passing, ok.key, { confirmation }).error?.code).toBe('COR_ITEM_NOT_ACCEPTABLE');
    expect(
      execute(
        createEmptyDocument(),
        'accept_corrosion_item',
        { itemKey: 'x', decision: 'accepted', justification: 'j', confirmation },
        signingContext,
      ).error?.code,
    ).toBe('COR_ENVIRONMENT_UNSET');
  });

  it('survives a history replay (the recorded step carries no signature)', () => {
    const { doc, key } = failing();
    const accepted = accept(doc, key, { confirmation: { nonce: 'n1' } }).document;
    const replayed = execute(accepted, 'replay_history', {}, signingContext);
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.corrosion?.acceptances[key]).toMatchObject({ decision: 'accepted', signer: 'alice' });
  });

  it('a replay never invents an acceptance: with the kept record gone the recorded step is refused', () => {
    const { doc, key } = failing();
    const accepted = accept(doc, key, { confirmation: { nonce: 'n1' } }).document;
    const stripped = { ...accepted, corrosion: { ...accepted.corrosion!, acceptances: {} } };
    const replayed = execute(stripped, 'replay_history', {}, signingContext);
    expect(replayed.document.corrosion?.acceptances[key]).toBeUndefined();
  });

  it('a recorded confirmation outside a replay is no signature', () => {
    const { doc, key } = failing();
    const forged = accept(doc, key, { confirmation: { verified: true } }, { ...signingContext, humanSignature: { verify: () => null } });
    expect(forged.error?.code).toBe('COR_HUMAN_GATE');
    expect(accept(doc, key, { confirmation: { verified: true } }, { ...defaultContext(), humanSignature: null }).error?.code).toBe(
      'COR_HUMAN_GATE',
    );
  });
});

describe('stored acceptances are re-verified, never trusted (a record in the slice proves nothing)', () => {
  /** A port that verifies only the signature the test minted for the genuine payload (recorded from a first, refused call). */
  function strictFor(doc: CadDocument, key: string): { ctx: ReturnType<typeof defaultContext>; accepted: CadDocument } {
    const payloads: string[] = [];
    const recording = { ...defaultContext(), humanSignature: { verify: (_s: unknown, payload: string) => (payloads.push(payload), null) } };
    accept(doc, key, { confirmation: { nonce: 'n' } }, recording);
    const strict: HumanSignaturePort = {
      verify: (signature, payload) =>
        (signature as { sig?: string }).sig === 'genuine' && payload === payloads[0] ? { signer: 'alice', signatureId: 'sig-1' } : null,
    };
    const ctx = { ...defaultContext(), humanSignature: strict };
    return { ctx, accepted: accept(doc, key, { confirmation: { nonce: 'n', sig: 'genuine' } }, ctx).document };
  }

  const forge = (doc: CadDocument, key: string, signature: unknown): CadDocument => {
    const real = accept(doc, key, { confirmation: { nonce: 'n' } }).document;
    const entry = real.corrosion?.acceptances[key];
    if (entry === undefined || real.corrosion === undefined) throw new Error('fixture');
    return { ...real, corrosion: { ...real.corrosion, acceptances: { [key]: { ...entry, signature } } } };
  };

  it('a genuine acceptance counts with a port that verifies it', () => {
    const { doc, key } = failing();
    const { ctx, accepted } = strictFor(doc, key);
    expect(accepted.corrosion?.acceptances[key]).toBeDefined();
    expect(check(accepted, {}, ctx)).toMatchObject({ status: 'pass', items: [{ acceptance: { decision: 'accepted' } }] });
  });

  it('a fabricated acceptance (junk signature) does not clear the item: it stays in the status and the count', () => {
    const { doc, key } = failing();
    const { ctx } = strictFor(doc, key);
    const forged = forge(doc, key, { nonce: 'n', sig: 'junk' });
    const result = check(forged, {}, ctx);
    expect(result.status).toBe('fail');
    expect(result.counts['accepted']).toBe(0);
    expect(result.items[0]).toMatchObject({ status: 'fail', unconfirmedAcceptance: 'invalid' });
    expect(result.items[0]?.acceptance).toBeUndefined();
  });

  it('without a signing port an acceptance cannot be confirmed and the item stays in the status', () => {
    const { doc, key } = failing();
    const accepted = accept(doc, key, { confirmation: { nonce: 'n' } }).document;
    const result = check(accepted, {}, { ...defaultContext(), humanSignature: null });
    expect(result).toMatchObject({ status: 'fail', items: [{ unconfirmedAcceptance: 'noport' }] });
    expect(result.counts['accepted']).toBe(0);
  });

  it('an acceptance copied into a document with another uid is foreign: still fail and counted', () => {
    const { doc, key } = failing();
    const { ctx, accepted } = strictFor(doc, key);
    const copy = { ...accepted, uid: 'f'.repeat(32) };
    const result = check(copy, {}, ctx);
    expect(result).toMatchObject({ status: 'fail', items: [{ unconfirmedAcceptance: 'foreign' }] });
    expect(result.counts['accepted']).toBe(0);
  });

  it('an acceptance without a recorded uid is unbound', () => {
    const { doc, key } = failing();
    const real = accept(doc, key, { confirmation: { nonce: 'n' } }).document;
    const entry = real.corrosion?.acceptances[key];
    if (entry === undefined || real.corrosion === undefined) throw new Error('fixture');
    const unbound = { ...real, corrosion: { ...real.corrosion, acceptances: { [key]: { ...entry, documentUid: '' } } } };
    expect(check(unbound, {}, signingContext)).toMatchObject({ status: 'fail', items: [{ unconfirmedAcceptance: 'unbound' }] });
  });

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a prototype-shaped object', { nonce: 'n', constructor: { prototype: {} } }],
    ['a huge nonce', { nonce: 'x'.repeat(100_000) }],
  ])('a hostile signature (%s) never improves a status: no port and strict port both keep fail', (_label, signature) => {
    const { doc, key } = failing();
    const { ctx } = strictFor(doc, key);
    const forged = forge(doc, key, signature);
    for (const context of [ctx, { ...defaultContext(), humanSignature: null }]) {
      const result = check(forged, {}, context);
      expect(result.status).toBe('fail');
      expect(result.counts['accepted']).toBe(0);
    }
  });
});
