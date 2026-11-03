import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { CadDocument } from '@core/model/types';
import { useLayoutStore, useStore } from '@ui/store';
import { usePipeStressStore } from '@ui/store/pipeStressStore';
import { useFocusStore } from '@ui/store/focusStore';
import { Sidebar } from '@ui/components/Sidebar';
import { PipeStressPanel } from '@ui/panels/pipeStress/PipeStressPanel';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';
import { anchorAt, baseDoc, cases, conditioned, withModel, withPipe } from '../unit/plant/stress/m3Fixtures';

const OD_NPS6 = 168.3;

function load(document: CadDocument): void {
  useStore.getState().setDocument(document);
}

/** Two-anchor L-bend 6 m x 3 m with thermal expansion, default B31.3 cases (SUS, OPE, EXP). */
function lBendModel(withConditions: boolean, tempC = 207.5): { doc: CadDocument; modelId: string } {
  const { doc, id: pipeId } = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [6000, 0, 3000],
      [6000, 3000, 3000],
    ],
    OD_NPS6,
    { dn: 150 },
  );
  const { doc: modelled, id } = withModel(doc, [pipeId]);
  if (!withConditions) return { doc: modelled, modelId: id };
  const set = conditioned(
    modelled,
    id,
    { installTempC: 20, temperatures: [{ name: 'T1', tempC }], wallMm: 7.11 },
    { thermal: { meanCtePerK: 1.2e-5 } },
  );
  const anchored = anchorAt(anchorAt(set, id, pipeId, 0), id, pipeId, 9000);
  const set3 = [
    { name: 'L1', type: 'SUS', basic: ['W'] },
    { name: 'L2', type: 'OPE', basic: ['W', 'T1'] },
    {
      name: 'L3',
      type: 'EXP',
      combine: [
        { case: 'L2', factor: 1 },
        { case: 'L1', factor: -1 },
      ],
    },
  ];
  return { doc: cases(anchored, id, set3), modelId: id };
}

beforeEach(() => {
  resetStore();
  useStore.setState({ liveStatus: 'disconnected' });
  useLayoutStore.setState({ sidebarTab: 'pipestress', sidebarOpen: true, pinnedTabs: [] });
});

describe('PipeStressPanel', () => {
  it('offers creating a stress model when the document has none', () => {
    render(<PipeStressPanel />);
    expect(screen.getByText('No stress model yet')).toBeInTheDocument();
  });

  it('lists the load cases, the worst stations and the verdict of the analysis', () => {
    const { doc } = lBendModel(true);
    load(doc);
    render(<PipeStressPanel />);
    expect(screen.getByTestId('stress-status')).toBeInTheDocument();
    expect(screen.getByTestId('stress-cases').querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('stress-stations').querySelectorAll('li').length).toBeGreaterThan(0);
    expect(screen.getByTestId('stress-review-required')).toBeInTheDocument();
    expect(usePipeStressStore.getState().modelId).not.toBeNull();
  });

  it('shows the failure summary, not data, when the analysis is refused', () => {
    load(lBendModel(false).doc);
    render(<PipeStressPanel />);
    expect(screen.getByTestId('stress-refused')).toHaveTextContent(/PST_CONDITIONS_MISSING|conditions/i);
    expect(screen.queryByTestId('stress-cases')).toBeNull();
    expect(screen.getByTestId('stress-record')).toBeDisabled();
  });

  it('prints the ratio colour legend', () => {
    load(lBendModel(true).doc);
    render(<PipeStressPanel />);
    for (const tone of ['pass', 'warn', 'fail', 'unknown']) expect(screen.getByTestId('stress-legend-' + tone)).toBeInTheDocument();
  });

  it('toggles the overlay and picks its load case through the UI store', () => {
    load(lBendModel(true).doc);
    render(<PipeStressPanel />);
    fireEvent.click(screen.getByTestId('stress-overlay-toggle'));
    expect(usePipeStressStore.getState().shown).toBe(true);
    fireEvent.change(screen.getByTestId('stress-case-select'), { target: { value: 'L1' } });
    expect(usePipeStressStore.getState().caseName).toBe('L1');
  });

  it('focuses a worst station: a beacon on the pipe, never a document change', () => {
    const { doc } = lBendModel(true);
    load(doc);
    render(<PipeStressPanel />);
    const before = useStore.getState().document;
    fireEvent.click(screen.getAllByRole('button').filter((b) => b.closest('[data-testid^="stress-station-"]'))[0] as HTMLElement);
    expect(useFocusStore.getState().focus?.key).toMatch(/^pipestress:station:/);
    expect(useFocusStore.getState().focus?.markers).toHaveLength(1);
    expect(useStore.getState().document).toBe(before);
  });

  it('records through a command and reflects not approved, then stale after an edit', () => {
    const { doc, modelId } = lBendModel(true);
    load(doc);
    render(<PipeStressPanel />);
    expect(screen.getByTestId('stress-approval-status')).toHaveTextContent('Not recorded');
    expect(screen.getByTestId('stress-approve')).toBeDisabled();
    fireEvent.click(screen.getByTestId('stress-record'));
    expect(useStore.getState().document.plant?.stress?.models[modelId]?.recorded).toBeDefined();
    expect(screen.getByTestId('stress-approval-status')).toHaveTextContent('Not approved');
    act(() => {
      localDispatch('update_stress_model', { modelId, name: 'Renamed', elbowRadiusFactor: 1.5 });
    });
    expect(screen.getByTestId('stress-approval-status')).toHaveTextContent(/Stale/);
    expect(screen.getByTestId('stress-approve')).toBeDisabled();
  });

  it('opens the signature dialog to approve a passing record; the panel never approves by itself', () => {
    const { doc, modelId } = lBendModel(true);
    load(doc);
    localDispatch('record_pipe_stress_results', { modelId });
    render(<PipeStressPanel />);
    const recorded = useStore.getState().document.plant?.stress?.models[modelId]?.recorded;
    expect(recorded).toBeDefined();
    const button = screen.getByTestId('stress-approve');
    expect(recorded?.status).toBe('pass');
    fireEvent.click(button);
    expect(screen.getByTestId('sign-summary')).toHaveTextContent(modelId);
    expect(useStore.getState().document.plant?.stress?.models[modelId]?.approval).toBeUndefined();
  });
});

describe('PipeStressPanel failing record', () => {
  it('keeps Approve disabled for a failing record and says why', () => {
    const { doc, modelId } = lBendModel(true, 700);
    load(doc);
    localDispatch('record_pipe_stress_results', { modelId });
    render(<PipeStressPanel />);
    expect(useStore.getState().document.plant?.stress?.models[modelId]?.recorded?.status).toBe('fail');
    expect(screen.getByTestId('stress-approve')).toBeDisabled();
    expect(screen.getByText(/fail record cannot be approved/)).toBeInTheDocument();
  });
});

describe('Sidebar tab', () => {
  it('puts the Pipe stress tab on the rail once the document holds a stress model', () => {
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true, pinnedTabs: [] });
    render(<Sidebar />);
    expect(screen.queryByRole('tab', { name: /^Pipe stress/ })).toBeNull();
    act(() => load(lBendModel(true).doc));
    expect(screen.getByRole('tab', { name: /^Pipe stress/ })).toBeInTheDocument();
  });
});
