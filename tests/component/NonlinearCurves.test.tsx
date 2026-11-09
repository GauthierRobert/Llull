import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { NonlinearCurves } from '@ui/panels/analysis/NonlinearCurves';
import { parseLimitLoad, parseNonlinearReport, plotCurve } from '@ui/panels/analysis/nonlinearCurveData';
import { solvedPressure, solvedPull, type SolvedCurve } from '../unit/cae/nonlinear/limitFixtures';

/** The panel reads the report where the artifacts live; in this suite that is the fixture's in-memory store (the mock below). */
const mocks = vi.hoisted(() => ({ ctx: undefined as ExecutionContext | undefined }));

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> =>
      execute(useStore.getState().document, command, params, mocks.ctx),
  };
});

const caseOf = (doc: CadDocument, analysisId: string): AnalysisCase => {
  const found = doc.analysis?.cases[analysisId];
  if (found === undefined) throw new Error('no case');
  return found;
};

function open(solved: SolvedCurve, doc: CadDocument = solved.doc): void {
  mocks.ctx = solved.ctx;
  useStore.getState().setDocument(doc);
  render(<NonlinearCurves analysisCase={caseOf(doc, solved.analysisId)} />);
}

const LOADS = [105, 250, 260, 240, 200];

describe('NonlinearCurves (PHY-05 NLS-M2b)', () => {
  beforeEach(() => {
    cleanup();
    mocks.ctx = undefined;
  });

  it('draws the curve of a solved case with its status, limit load and the review sentence', () => {
    const solved = solvedPull(LOADS);
    open(solved);
    expect(screen.getByTestId('nonlinear-status').textContent).toMatch(/nlgeom true · \d+ increments in 1 step\(s\).*all steps completed/);
    const plot = screen.getByTestId(`nonlinear-plot-${solved.probeId}`);
    expect(plot.getAttribute('role')).toBe('img');
    expect(plot.getAttribute('aria-label')).toMatch(/pull_curve.*load \(N\) against displacement \(mm\)/);
    expect(plot.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(6);
    expect(screen.getByTestId(`nonlinear-limit-${solved.probeId}`).textContent).toMatch(/Limit load 26\d.* N \(peak\)/);
    expect(screen.getByTestId('nonlinear-review').textContent).toContain('not approved');
    expect(screen.queryByTestId(`nonlinear-snapback-${solved.probeId}`)).toBeNull();
  });

  it('the increment slider moves the marker and the readout', () => {
    const solved = solvedPull(LOADS);
    open(solved);
    const slider = screen.getByTestId(`nonlinear-slider-${solved.probeId}`) as HTMLInputElement;
    expect(slider.max).toBe('5');
    expect(screen.getByTestId(`nonlinear-readout-${solved.probeId}`).textContent).toMatch(
      /Sample 6 of 6: load 200 N at displacement 0\.01 mm/,
    );
    const before = screen.getByTestId(`nonlinear-marker-${solved.probeId}`).getAttribute('cx');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(screen.getByTestId(`nonlinear-readout-${solved.probeId}`).textContent).toMatch(/Sample 4 of 6: load 260 N/);
    expect(screen.getByTestId(`nonlinear-marker-${solved.probeId}`).getAttribute('cx')).not.toBe(before);
  });

  it('says a curve that never peaks gives only a lower bound, and flags a snap-back', () => {
    const rising = solvedPressure();
    open(rising);
    expect(screen.getByTestId(`nonlinear-limit-${rising.probeId}`).textContent).toMatch(/Limit not reached: the load is at least 50 MPa/);
    cleanup();
    const turning = solvedPull(LOADS, [0.002, 0.004, 0.003, 0.0025, 0.002]);
    open(turning);
    expect(screen.getByTestId(`nonlinear-snapback-${turning.probeId}`).textContent).toBe('snap-back');
  });

  it('shows the command summary when the results are stale instead of numbers', () => {
    const solved = solvedPull(LOADS);
    const changed = execute(solved.doc, 'set_nonlinear_controls', { analysisId: solved.analysisId, nlgeom: false }).document;
    open(solved, changed);
    expect(screen.getByTestId('nonlinear-summary').textContent).toMatch(/NLS_CURVE_STALE|predate a change/);
    expect(screen.queryByTestId(`nonlinear-plot-${solved.probeId}`)).toBeNull();
  });
});

describe('nonlinearCurveData readers', () => {
  it('parse only well-formed data and map magnitudes to the plot box', () => {
    expect(parseNonlinearReport(null)).toBeNull();
    expect(parseNonlinearReport({ completed: 'yes', curves: [] })).toBeNull();
    const view = parseNonlinearReport({
      completed: true,
      curves: [
        { probeId: 'a', name: 'a', loadUnit: 'N', displacementUnit: 'mm', points: 2, maxLoad: 10, load: [0, -10], displacement: [0, 2] },
        { probeId: 'b', name: 'b', loadUnit: 'N', displacementUnit: 'mm', points: 2, maxLoad: 1, load: [0], displacement: [0, 1] },
        'junk',
      ],
    });
    expect(view?.curves.map((curve) => curve.probeId)).toEqual(['a']);
    const curve = view?.curves[0];
    if (curve === undefined) throw new Error('no curve');
    const plot = plotCurve(curve, { width: 100, height: 100, margin: 10 });
    expect(plot.at(0)).toEqual({ x: 10, y: 90 });
    expect(plot.at(1)).toEqual({ x: 90, y: 10 });
    expect(plotCurve({ ...curve, load: [0, 0], displacement: [0, 0] }, { width: 100, height: 100, margin: 10 }).at(1)).toEqual({
      x: 10,
      y: 90,
    });
    expect(parseLimitLoad({ found: 'peak', limitLoad: 5, atDisplacement: 1, loadUnit: 'N', lengthUnit: 'mm' })).toMatchObject({
      kind: 'limit',
      value: 5,
    });
    expect(parseLimitLoad({ found: 'not_reached', lowerBound: 4, atDisplacement: 1, loadUnit: 'N', lengthUnit: 'mm' })).toMatchObject({
      kind: 'lowerBound',
      value: 4,
    });
    expect(parseLimitLoad({ found: 'peak', atDisplacement: 1 })).toBeNull();
  });
});
