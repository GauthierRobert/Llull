import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { AnalysisCase, HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import { isRecord } from '@lib/isRecord';
import { EXCEPTION_ACT, exceptionDetails } from '@cae/vnv/studyException';
import type { CadDocument } from '@core/model/types';
import { VerificationPanel } from '@ui/panels/analysis/VerificationPanel';
import { parseVerification, quantityText } from '@ui/panels/analysis/verificationData';
import { localDispatch } from '../helpers/storeTestHelpers';
import { dtStudyBar, orderStudyBar, recordKind, type KindBar } from '../unit/cae/vnv/kindFixtures';
import { recordedStudy, studyBar } from '../unit/cae/vnv/studyFixtures';

/** The panel reads check_verification where the artifacts live; in this suite that is the fixture's in-memory store (the mock below). */
const mocks = vi.hoisted(() => ({ ctx: undefined as ExecutionContext | undefined }));

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> =>
      execute(useStore.getState().document, command, params, mocks.ctx),
  };
});

const originalDispatch = useStore.getInitialState().dispatch;
let dispatched: Array<{ name: string; params: Record<string, unknown> }> = [];

const caseOf = (doc: CadDocument, analysisId: string): AnalysisCase => {
  const found = doc.analysis?.cases[analysisId];
  if (found === undefined) throw new Error('no case');
  return found;
};

function open(bar: KindBar | ReturnType<typeof studyBar>, doc: CadDocument): void {
  mocks.ctx = bar.ctx;
  useStore.getState().setDocument(doc);
  render(<VerificationPanel analysisCase={caseOf(doc, bar.analysisId)} />);
}

describe('VerificationPanel (PHY-00 VNV-M4)', () => {
  beforeEach(() => {
    cleanup();
    dispatched = [];
    mocks.ctx = undefined;
    useStore.setState({
      dispatch: (name, params) => {
        dispatched.push({ name, params: (params ?? {}) as Record<string, unknown> });
        localDispatch(name, params);
      },
    });
  });
  afterEach(() => useStore.setState({ dispatch: originalDispatch }));

  it('shows the empty state for a case without a study', () => {
    const bar = studyBar();
    open(bar, bar.doc);
    expect(screen.getByTestId('verification-none')).toBeTruthy();
    expect(screen.getByTestId('verification-status').textContent).toBe('warn');
  });

  it('a 3-level h study shows its levels, the observed order, the GCI and the method', () => {
    const bar = studyBar();
    open(bar, recordedStudy(bar).doc);
    const card = screen.getByTestId(/verification-study-cs-/);
    expect(card.getAttribute('data-refinement')).toBe('h');
    expect(within(card).getByText(/Mesh size \(h\)/)).toBeTruthy();
    expect(screen.getByTestId(/verification-state-/).textContent).toBe('current');
    expect(screen.getByTestId('verification-order').textContent).toMatch(/Observed order p = 2/);
    expect(screen.getByTestId('verification-gci').textContent).toMatch(/GCI of the finest level: .* %/);
    expect(screen.getByTestId('verification-method').textContent).toMatch(/Celik et al\. 2008 GCI \(3 levels\)/);
    expect(within(screen.getByTestId(/verification-levels-/)).getAllByRole('row')).toHaveLength(4);
  });

  it('a 4-level study names the least-squares method and shows the fit residual and uncertainty', () => {
    const bar = studyBar({ cells: [8, 4, 2, 1] });
    open(bar, recordedStudy(bar).doc);
    expect(screen.getByTestId('verification-method').textContent).toMatch(/Least-squares fit.*Eça & Hoekstra/);
    expect(screen.getByTestId('verification-order').textContent).toMatch(/Observed order p = 2.*± .*standard error.*extrapolated 100/);
    expect(screen.getByTestId('verification-lsq').textContent).toMatch(
      /Fit residual: standard deviation .*1 degree\(s\) of freedom.*uncertainty .* % of the finest value/,
    );
    expect(screen.queryByTestId('verification-gci')).toBeNull();
  });

  it('a time-step study lists the increments in seconds', () => {
    const bar = dtStudyBar();
    open(bar, recordKind(bar).doc);
    const card = screen.getByTestId(/verification-study-cs-/);
    expect(card.getAttribute('data-refinement')).toBe('dt');
    expect(within(card).getByText('Δt (s)')).toBeTruthy();
    expect(screen.getByTestId('verification-order').textContent).toMatch(/Observed order p = 1.*extrapolated 20/);
  });

  it('an order study shows the difference indicator and never an observed order', () => {
    const bar = orderStudyBar();
    open(bar, recordKind(bar).doc);
    expect(screen.getByTestId('verification-order-pair').textContent).toMatch(/difference 3 MPa \(7\.5 %\).*no observed order/);
    expect(screen.queryByTestId('verification-order')).toBeNull();
    expect(within(screen.getByTestId(/verification-levels-/)).getByText('Element order')).toBeTruthy();
  });

  it('a stale study shows no number, says why, and can be deleted through delete_convergence_study', () => {
    const bar = studyBar();
    const recorded = recordedStudy(bar);
    const scaled = execute(recorded.doc, 'scale_entity', { id: bar.boxId, factor: 2 }).document;
    open(bar, scaled);
    expect(screen.getByTestId(/verification-state-/).textContent).toBe('stale');
    expect(screen.queryByTestId('verification-report')).toBeNull();
    expect(screen.getByTestId('verification-item-VNV_STUDY_STALE')).toBeTruthy();
    fireEvent.click(screen.getByTestId(`verification-delete-${recorded.studyId}`));
    expect(dispatched).toEqual([{ name: 'delete_convergence_study', params: { analysisId: bar.analysisId, studyId: recorded.studyId } }]);
  });

  it('the GCI target field feeds gciTarget (percent to fraction) and an invalid value is ignored', () => {
    const bar = studyBar();
    open(bar, recordedStudy(bar).doc);
    expect(screen.queryByTestId('verification-item-VNV_GCI_TARGET_UNSET')).not.toBeNull();
    fireEvent.change(screen.getByTestId('verification-target'), { target: { value: '5' } });
    expect(screen.queryByTestId('verification-item-VNV_GCI_TARGET_UNSET')).toBeNull();
    fireEvent.change(screen.getByTestId('verification-target'), { target: { value: '-3' } });
    expect(screen.queryByTestId('verification-item-VNV_GCI_TARGET_UNSET')).not.toBeNull();
  });

  it('an exception accepted by a reviewer shows the port-verified signer and its justification', () => {
    const bar = studyBar({ cells: [8, 4, 2, 1], value: (_h, level) => 100 + [0, 0.05, 0.15, 0.55][level]! });
    const { doc, studyId } = recordedStudy(bar);
    const stored = caseOf(doc, bar.analysisId).studies?.[studyId];
    if (stored === undefined) throw new Error('no study');
    const justification = 'reserve of 40 % on the margin';
    const payload = humanGatePayload(
      EXCEPTION_ACT,
      [studyId],
      exceptionDetails(stored, 'VNV_LSQ_POOR_FIT', justification, doc.uid ?? ''),
      'n-1',
    );
    // a stand-in for the 09 PLM key holder: the signature is the payload it signs; the NAME shown is the one the port returns
    const port: HumanSignaturePort = {
      verify: (signature, shown) =>
        isRecord(signature) && signature['payload'] === shown ? { signer: 'Dr. Reviewer', signatureId: 'sig-1' } : null,
      spend: () => true,
    };
    const ctx: ExecutionContext = { ...bar.ctx, humanSignature: port };
    const accepted = execute(
      doc,
      'accept_verification_exception',
      { analysisId: bar.analysisId, studyId, code: 'VNV_LSQ_POOR_FIT', justification, confirmation: { nonce: 'n-1', payload } },
      ctx,
    );
    expect(accepted.rejected).not.toBe(true);
    mocks.ctx = ctx;
    useStore.getState().setDocument(accepted.document);
    render(<VerificationPanel analysisCase={caseOf(accepted.document, bar.analysisId)} />);
    expect(screen.getByTestId('verification-accepted-VNV_LSQ_POOR_FIT').textContent).toContain(
      'Accepted by Dr. Reviewer (signature sig-1): reserve of 40 % on the margin',
    );
    expect(screen.getByTestId(`verification-exception-${studyId}`).textContent).toMatch(/VNV_LSQ_POOR_FIT by Dr. Reviewer/);
    expect(screen.getByTestId('verification-gate-note').textContent).toMatch(/cannot be signed from this panel yet/);
    expect(dispatched).toEqual([]);
  });

  it('shows the refusal summary when check_verification refuses', () => {
    const bar = studyBar();
    mocks.ctx = bar.ctx;
    useStore.getState().setDocument(bar.doc);
    render(<VerificationPanel analysisCase={{ ...caseOf(bar.doc, bar.analysisId), id: 'an-9.9' }} />);
    expect(screen.getByTestId('verification-refused').textContent).toMatch(/an-9\.9/);
  });
});

describe('parseVerification / quantityText', () => {
  it('reads nothing from a refused or malformed answer', () => {
    expect(parseVerification(null)).toBeNull();
    expect(parseVerification({ studies: 'x', items: [] })).toBeNull();
    expect(
      parseVerification({ studies: [{ id: 'cs-1', refinement: 'x', state: 'current' }], items: [{ code: 3 }], status: 'weird' }),
    ).toEqual({ status: 'warn', items: [], studies: [], reviewRequired: false, gciTarget: null });
  });

  it('names every quantity kind', () => {
    expect(quantityText({ kind: 'probe', probeId: 'p-1', loadCase: 'LC1' })).toBe('probe p-1 (LC1)');
    expect(quantityText({ kind: 'field_max', field: 'u_mag', loadCase: 'LC1' })).toBe('max displacement (LC1)');
    expect(quantityText({ kind: 'frequency', mode: 2 })).toBe('frequency, mode 2');
    expect(quantityText({ kind: 'buckling_factor', mode: 1 })).toBe('buckling factor, mode 1');
    expect(quantityText({ kind: 'nope' })).toBe('?');
    expect(quantityText(null)).toBe('?');
  });
});
