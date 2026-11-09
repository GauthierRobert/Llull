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
    const after = check(result.document);
    expect(after.items[0]).toMatchObject({ status: 'fail', acceptance: { decision: 'accepted', signer: 'alice' } });
    expect(after.status).toBe('pass');
    expect(after.counts['accepted']).toBe(1);
    expect(check(doc).status).toBe('fail');
  });

  it('a rejected decision is recorded but still counts against the status', () => {
    const { doc, key } = failing();
    const result = accept(doc, key, { decision: 'rejected', confirmation: { nonce: 'n1' } });
    expect(check(result.document).items[0]?.acceptance?.decision).toBe('rejected');
    expect(check(result.document).status).toBe('fail');
  });

  it('the acceptance ends when the finding changes (another environment): staleAcceptance, status back to fail', () => {
    const { doc, key } = failing();
    const accepted = accept(doc, key, { confirmation: { nonce: 'n1' } }).document;
    const changed = run(accepted, 'set_service_environment', { scheme: 'anodic_index', environment: 'harsh' });
    const item = check(changed).items[0];
    expect(item?.acceptance).toBeUndefined();
    expect(item?.staleAcceptance).toBe(true);
    expect(check(changed).status).toBe('fail');
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
