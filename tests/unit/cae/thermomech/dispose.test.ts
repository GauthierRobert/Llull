import type { ExecutionContext } from '@core/commands/types';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { G6, H7, SPEC_20C, explicitCte } from '../../physics/thermomech/thermomechFixtures';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { thermoFixture } from './fixtures';

const params = {
  rowKey: 'hole 20 degC | shaft 20 degC',
  decision: 'accepted',
  justification: 'checked by hand',
  inputsHash: 'h1',
  signature: 'good',
};
const payload = (): string =>
  sha256Hex(
    canonicalJson({
      act: 'dispose_fit_result',
      rowKey: params.rowKey,
      decision: 'accepted',
      justification: 'checked by hand',
      inputsHash: 'h1',
    }),
  );

const port = (seen: string[] = []): HumanSignaturePort => ({
  verify: (signature, hash) => {
    seen.push(hash);
    return signature === 'good' ? { signer: 'alice', signatureId: 'sig-1' } : null;
  },
});
const withPort = (seen?: string[]): ExecutionContext => ({ ...defaultContext(), humanSignature: port(seen) });

describe('dispose_fit_result (human gate)', () => {
  const { doc } = thermoFixture();

  it('refuses an agent call without a signing port (VC-TMC-63) and leaves the document unchanged', () => {
    const result = execute(doc, 'dispose_fit_result', params);
    expectNoOp(result, doc);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('TMC_HUMAN_GATE');
    expect(JSON.stringify(result.document)).toBe(JSON.stringify(doc));
  });

  it('refuses a signature that does not verify', () => {
    const result = execute(doc, 'dispose_fit_result', { ...params, signature: 'forged' }, withPort());
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('TMC_HUMAN_GATE');
  });

  it('records the disposition with the verified signer over the payload hash', () => {
    const seen: string[] = [];
    const result = execute(doc, 'dispose_fit_result', params, withPort(seen));
    expect(seen).toEqual([payload()]);
    expect(result.affected).toEqual([params.rowKey]);
    expect(result.document.analysis?.fitDispositions).toEqual({
      [params.rowKey]: {
        decision: 'accepted',
        justification: 'checked by hand',
        inputsHash: 'h1',
        signer: 'alice',
        signatureId: 'sig-1',
        signature: params.signature,
      },
    });
    expect(result.document.analysis?.cases).toEqual(doc.analysis?.cases);
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'dispose_fit_result', params, withPort()));
  });

  it('refuses when the inputs hash moved (TMC_FIT_INPUTS_CHANGED) or the justification is empty', () => {
    const moved = execute(doc, 'dispose_fit_result', { ...params, currentInputsHash: 'h2' }, withPort());
    expectNoOp(moved, doc);
    expect(moved.error?.code).toBe('TMC_FIT_INPUTS_CHANGED');
    const same = execute(doc, 'dispose_fit_result', { ...params, currentInputsHash: 'h1' }, withPort());
    expect(same.affected).toEqual([params.rowKey]);
    const empty = execute(doc, 'dispose_fit_result', { ...params, justification: '  ', signature: 'good' }, withPort());
    expectNoOp(empty, doc);
    expect(empty.error?.code).toBe('FEA_PARAM_INVALID');
  });

  it('with fitParams the command recomputes the row itself: the hash must be the row of THAT fit, whatever the client says', () => {
    const fitParams = {
      hole: H7,
      shaft: G6,
      holeCte: explicitCte(23e-6),
      shaftCte: explicitCte(12e-6),
      specTemperature: SPEC_20C,
      temperatures: [{ value: 80, unit: 'degC' }],
    };
    const fit = execute(doc, 'fit_at_temperature', fitParams);
    const row = (fit.data as { rows: { rowKey: string }[] }).rows[0];
    if (row === undefined) throw new Error('no fit row');
    const honest = { ...params, rowKey: row.rowKey, inputsHash: sha256Hex(jcsJson(row)), fitParams };
    expect(execute(doc, 'dispose_fit_result', honest, withPort()).affected).toEqual([row.rowKey]);
    const stale = execute(doc, 'dispose_fit_result', { ...honest, inputsHash: 'h1', currentInputsHash: 'h1' }, withPort());
    expectNoOp(stale, doc);
    expect(stale.error?.code).toBe('TMC_FIT_INPUTS_CHANGED');
    const changed = execute(
      doc,
      'dispose_fit_result',
      { ...honest, fitParams: { ...fitParams, temperatures: [{ value: 90, unit: 'degC' }] } },
      withPort(),
    );
    expect(changed.error?.code).toBe('TMC_FIT_INPUTS_CHANGED');
  });

  it('keeps earlier dispositions when recording another row', () => {
    const first = execute(doc, 'dispose_fit_result', params, withPort());
    const second = execute(first.document, 'dispose_fit_result', { ...params, rowKey: 'other', decision: 'rejected' }, withPort());
    expect(Object.keys(second.document.analysis?.fitDispositions ?? {})).toEqual([params.rowKey, 'other']);
  });
});
