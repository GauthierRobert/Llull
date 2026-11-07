/**
 * accept_verification_exception: the human gate of the verification harness (PHY-00 VC-VNV-14, TR-VNV-12). The study f(h) = 1 + h^2 has a constant
 * ratio 2 and order 2, but its asymptotic ratio is f2 / f1 = (1 + 4x) / (1 + x) > 1.05 (x = h1^2 ~ 0.019: 1.0556): VNV_NOT_ASYMPTOTIC (hand-derived).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { humanGatePayload } from '@core/model/humanGate';
import { EXCEPTION_ACT, exceptionDetails } from '@cae/vnv/studyException';
import type { CaseStudy } from '@cae/vnv/studyState';
import { expectCase } from '../../physics/benchmarkCases';
import { expectBoundToDocument, expectRefusesWithoutUid } from '../../../helpers/documentBinding';
import { recordedStudy, studyBar, type StudyBar } from './studyFixtures';

const SIGNER = 'Dr. Reviewer';

/** A signing port whose signature is the payload it signs (a stand-in for the 09 PLM key holder); each signature is spendable once. */
function signingPort(): HumanSignaturePort & { readonly spentCount: () => number } {
  const spent = new Set<string>();
  return {
    verify: (signature, payload) =>
      isRecord(signature) && signature['payload'] === payload ? { signer: SIGNER, signatureId: `sig-${payload.slice(0, 8)}` } : null,
    spend: (signature) => {
      const key = JSON.stringify(signature);
      if (spent.has(key)) return false;
      spent.add(key);
      return true;
    },
    spentCount: () => spent.size,
  };
}

const lawBar = (): StudyBar => studyBar({ value: (h) => 1 + h * h });
const JUSTIFICATION = 'refined locally elsewhere; the margin has 40 % reserve';

function study(doc: CadDocument, bar: StudyBar, id: string): CaseStudy {
  const found = doc.analysis?.cases[bar.analysisId]?.studies?.[id];
  if (found === undefined) throw new Error('no study');
  return found;
}

/** What the reviewer signs for the study (the same payload the command verifies). */
const signatureFor = (doc: CadDocument, bar: StudyBar, id: string, code: string, nonce = 'n-1'): { payload: string; nonce: string } => ({
  nonce,
  payload: humanGatePayload(EXCEPTION_ACT, [id], exceptionDetails(study(doc, bar, id), code, JUSTIFICATION, doc.uid ?? ''), nonce),
});

const humanContext = (bar: StudyBar, port: HumanSignaturePort): ExecutionContext => ({ ...bar.ctx, humanSignature: port });

const accept = (
  doc: CadDocument,
  bar: StudyBar,
  id: string,
  ctx: ExecutionContext,
  extra: Record<string, unknown> = {},
): ReturnType<typeof execute> =>
  execute(
    doc,
    'accept_verification_exception',
    { analysisId: bar.analysisId, studyId: id, code: 'VNV_NOT_ASYMPTOTIC', justification: JUSTIFICATION, ...extra },
    ctx,
  );

describe('accept_verification_exception: the human gate (VC-VNV-14)', () => {
  const bar = lawBar();
  const { doc, studyId } = recordedStudy(bar);

  it('the study shows VNV_NOT_ASYMPTOTIC (oracle: asymptotic ratio f2 / f1 above the 1.05 band)', () => {
    const x = (study(doc, bar, studyId).levels[0]?.h ?? Number.NaN) ** 2;
    expect((1 + 4 * x) / (1 + x)).toBeGreaterThan(1.05);
    const data = execute(doc, 'check_verification', { analysisId: bar.analysisId, gciTarget: 0.5 }, bar.ctx).data as {
      items: { code: string }[];
    };
    expect(data.items.map((item) => item.code)).toContain('VNV_NOT_ASYMPTOTIC');
  });

  it('an agent without a signature or a signing port is refused with VNV_HUMAN_GATE, the document unchanged', () => {
    for (const ctx of [bar.ctx, humanContext(bar, signingPort())]) {
      const result = accept(doc, bar, studyId, ctx);
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe('VNV_HUMAN_GATE');
      expectCase('00-vv-harness', 'VC-VNV-14', result.error?.code ?? 'none');
      expect(result.error?.remediation).toMatch(/qualified reviewer/);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
  });

  it('a bare true, a string and a forged signature are refused the same way', () => {
    const ctx = humanContext(bar, signingPort());
    for (const signature of [
      true,
      'signed',
      { payload: 'f'.repeat(64), nonce: 'n-1' },
      { payload: signatureFor(doc, bar, studyId, 'VNV_NOT_ASYMPTOTIC').payload },
    ]) {
      const result = accept(doc, bar, studyId, ctx, { signature });
      expect(result.error?.code).toBe('VNV_HUMAN_GATE');
      expect(result.document).toBe(doc);
    }
  });

  it('a signature made for another code, justification or study does not verify', () => {
    const ctx = humanContext(bar, signingPort());
    const other = signatureFor(doc, bar, studyId, 'VNV_ORDER_MISMATCH');
    expect(accept(doc, bar, studyId, ctx, { signature: other }).error?.code).toBe('VNV_HUMAN_GATE');
    const signature = signatureFor(doc, bar, studyId, 'VNV_NOT_ASYMPTOTIC');
    expect(accept(doc, bar, studyId, ctx, { signature, justification: `${JUSTIFICATION}!` }).error?.code).toBe('VNV_HUMAN_GATE');
  });

  it('records the acceptance with the signer through the real gate; check_verification lists it as accepted and re-verifies it', () => {
    const port = signingPort();
    const ctx = humanContext(bar, port);
    const signature = signatureFor(doc, bar, studyId, 'VNV_NOT_ASYMPTOTIC');
    const before = structuredClone(doc);
    const result = accept(doc, bar, studyId, ctx, { signature });
    expect(doc).toEqual(before);
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([studyId]);
    expect(result.summary).toMatch(new RegExp(`VNV_NOT_ASYMPTOTIC of '${studyId}' accepted by ${SIGNER}`));
    const exception = study(result.document, bar, studyId).exception;
    expect(exception).toMatchObject({ code: 'VNV_NOT_ASYMPTOTIC', signer: SIGNER, justification: JUSTIFICATION, documentUid: doc.uid });
    expect(exception?.levelHashes).toHaveLength(3);
    expect(port.spentCount()).toBe(1);

    const data = execute(result.document, 'check_verification', { analysisId: bar.analysisId, gciTarget: 0.5 }, ctx).data as {
      status: string;
      items: { code: string; accepted?: { signer: string } }[];
    };
    expect(data.items.find((item) => item.code === 'VNV_NOT_ASYMPTOTIC')?.accepted?.signer).toBe(SIGNER);
    // the accepted finding no longer raises the status; the default stress order (1) vs the observed 2 still stands
    expect(data.items.filter((item) => item.accepted === undefined).map((item) => item.code)).toEqual(['VNV_ORDER_MISMATCH']);
    expect(data.status).toBe('warn');
    const withoutPort = execute(result.document, 'check_verification', { analysisId: bar.analysisId, gciTarget: 0.5 }, bar.ctx)
      .data as typeof data;
    expect(withoutPort.items.map((item) => item.code)).toContain('VNV_HUMAN_GATE');
    expect(withoutPort.status).toBe('fail');
  });

  it('a signature is single use', () => {
    const port = signingPort();
    const ctx = humanContext(bar, port);
    const signature = signatureFor(doc, bar, studyId, 'VNV_NOT_ASYMPTOTIC');
    expect(accept(doc, bar, studyId, ctx, { signature }).rejected).not.toBe(true);
    expect(accept(doc, bar, studyId, ctx, { signature }).error?.code).toBe('VNV_HUMAN_GATE');
  });

  it('an acceptance is voided in a copied document (another uid)', () => {
    const port = signingPort();
    const ctx = humanContext(bar, port);
    const accepted = accept(doc, bar, studyId, ctx, { signature: signatureFor(doc, bar, studyId, 'VNV_NOT_ASYMPTOTIC') }).document;
    const copied: CadDocument = { ...accepted, uid: 'c'.repeat(32) };
    const data = execute(copied, 'check_verification', { analysisId: bar.analysisId, gciTarget: 0.5 }, ctx).data as {
      items: { code: string }[];
    };
    expect(data.items.map((item) => item.code)).toContain('VNV_HUMAN_GATE');
  });

  it('refuses what is not applicable, before spending the signature', () => {
    const port = signingPort();
    const ctx = humanContext(bar, port);
    const signature = signatureFor(doc, bar, studyId, 'VNV_DIVERGENT');
    const notShown = accept(doc, bar, studyId, ctx, { signature, code: 'VNV_DIVERGENT' });
    expect(notShown.error?.code).toBe('VNV_EXCEPTION_NOT_APPLICABLE');
    expect(accept(doc, bar, studyId, ctx, { signature, justification: '  ' }).error?.code).toBe('VNV_PARAM_INVALID');
    expect(accept(doc, bar, 'cs-9.9', ctx, { signature }).error?.code).toBe('VNV_STUDY_NOT_FOUND');
    expect(
      execute(doc, 'accept_verification_exception', { analysisId: 'an-9.9', studyId, code: 'VNV_NOT_ASYMPTOTIC', justification: 'x' }, ctx)
        .error?.code,
    ).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(
      execute(
        doc,
        'accept_verification_exception',
        { analysisId: bar.analysisId, studyId, code: 'VNV_GCI_ABOVE_TARGET', justification: 'x' },
        ctx,
      ).error?.code,
    ).toBe('CMD_INVALID_PARAMS');
    expect(port.spentCount()).toBe(0);
  });

  it('the signature names the document it was made for (GATE-UID)', () => {
    expectBoundToDocument(
      doc,
      (document, confirmation, context) => accept(document, bar, studyId, context, { signature: confirmation }),
      'VNV_HUMAN_GATE',
    );
  });

  it('refuses a stale study and a document without uid', () => {
    const port = signingPort();
    const ctx = humanContext(bar, port);
    const signature = signatureFor(doc, bar, studyId, 'VNV_NOT_ASYMPTOTIC');
    const scaled = execute(doc, 'scale_entity', { id: bar.boxId, factor: 2 }).document;
    expect(accept(scaled, bar, studyId, ctx, { signature }).error?.code).toBe('VNV_STUDY_STALE');
    expectRefusesWithoutUid(
      doc,
      (document, confirmation, context) => accept(document, bar, studyId, context, { signature: confirmation }),
      'FEA_DOCUMENT_UNIDENTIFIED',
      'VNV_HUMAN_GATE',
    );
    expect(port.spentCount()).toBe(0);
  });
});
