import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { AnalysisPanel } from '@ui/panels/analysis/AnalysisPanel';
import { useAnalysisViewStore } from '@ui/panels/analysis/analysisViewStore';
import { AnalysisLegend } from '@ui/viewport/3d/analysis/AnalysisLegend';
import { useFocusStore } from '@ui/store/focusStore';
import { localDispatch } from '../helpers/storeTestHelpers';

const mocks = vi.hoisted(() => ({ solved: false }));

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> => {
      const real = actual.runQuery(command, params);
      if (!mocks.solved || command !== 'describe_analysis' || params['analysisId'] === undefined) return real;
      const data = real.data as { case: Record<string, unknown> };
      const results = {
        loadCases: [
          {
            name: 'LC1',
            category: 'limit',
            maxVonMises: { value: 210, at: [5, 10, 0], entityId: '' },
            maxDisplacement: { value: 0.42, at: [5, 10, 30] },
          },
        ],
      };
      return { ...real, data: { ...data, state: 'solved', case: { ...data.case, results } } };
    },
  };
});

function seed(): { analysisId: string; boxId: string } {
  const boxId = localDispatch('add_box', { size: [10, 20, 30] }).affected[0]!;
  localDispatch('set_entity_name', { id: boxId, name: 'Bracket' });
  const analysisId = localDispatch('create_analysis', { name: 'Bracket under load', analysisType: 'static' }).affected[0]!;
  localDispatch('set_part_idealization', { analysisId, entityId: boxId });
  localDispatch('add_fea_constraint', {
    analysisId,
    name: 'base fixed',
    kind: 'fixed',
    target: { entityId: boxId, facesNear: [[5, 10, 0]] },
  });
  localDispatch('add_fea_load', {
    analysisId,
    name: 'tip load',
    kind: 'force',
    loadCase: 'LC1',
    vector: [0, 0, -500],
    target: { entityId: boxId, facesNear: [[5, 10, 30]] },
  });
  return { analysisId, boxId };
}

describe('Analysis panel on the model', () => {
  beforeEach(() => {
    cleanup();
    mocks.solved = false;
    useStore.getState().setDocument(createEmptyDocument());
    useFocusStore.setState({ focus: null });
    useAnalysisViewStore.setState({ analysisId: null, showOnModel: true });
  });

  it('publishes the open case to the view store while the panel is open and clears it on close', () => {
    const { analysisId } = seed();
    const { unmount } = render(<AnalysisPanel />);
    expect(useAnalysisViewStore.getState().analysisId).toBe(analysisId);
    unmount();
    expect(useAnalysisViewStore.getState().analysisId).toBeNull();
  });

  it('clicking a load row focuses its part with a value marker at the target point and selects the part', () => {
    const { boxId } = seed();
    render(<AnalysisPanel />);
    const row = within(screen.getByLabelText('Loads')).getByRole('button', { name: /Show tip load on the model/ });
    fireEvent.click(row);
    const { focus } = useFocusStore.getState();
    expect(focus?.key).toMatch(/^analysis:load:/);
    expect(focus?.entityIds).toEqual([boxId]);
    expect(focus?.markers).toEqual([{ position: [5, 10, 30], label: '500 N' }]);
    expect(useStore.getState().document.selection).toEqual([boxId]);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(row);
    expect(useFocusStore.getState().focus).toBeNull();
  });

  it('shows the value in the row meta and a swatch in the overlay colour', () => {
    seed();
    render(<AnalysisPanel />);
    const loads = within(screen.getByLabelText('Loads'));
    expect(loads.getByText('500 N · LC1')).toBeTruthy();
    const swatch = screen.getByLabelText('Loads').querySelector('.panel__swatch') as HTMLElement;
    expect(swatch.style.background).toBe('rgb(232, 121, 249)');
  });

  it('shows the set-up verdict and, when solved, the headline numbers; a tile highlights its location', () => {
    seed();
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-state-chip').textContent).toMatch(/Set-up incomplete|Ready to solve/);
    expect(screen.queryByTestId('kpi-von-mises')).toBeNull();
    cleanup();
    mocks.solved = true;
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-state-chip').textContent).toBe('Solved');
    expect(screen.getByTestId('kpi-von-mises').textContent).toContain('210 MPa');
    fireEvent.click(screen.getByTestId('kpi-displacement'));
    expect(useFocusStore.getState().focus?.markers[0]?.position).toEqual([5, 10, 30]);
  });

  it('says plainly why nothing is painted on an unsolved case, and drops the overlay when toggled off', () => {
    seed();
    render(
      <>
        <AnalysisPanel />
        <AnalysisLegend />
      </>,
    );
    expect(screen.getByTestId('analysis-paint-status').textContent).toContain('Not solved yet');
    expect(screen.getByTestId('analysis-legend').textContent).toContain('Not solved yet');
    fireEvent.click(screen.getByTestId('analysis-show-on-model'));
    expect(useAnalysisViewStore.getState().showOnModel).toBe(false);
    expect(screen.queryByTestId('analysis-legend')).toBeNull();
  });
});
