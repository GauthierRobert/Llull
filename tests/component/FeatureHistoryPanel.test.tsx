import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useStore } from '@ui/store';
import { type FeatureStep, createEmptyDocument } from '@core/model/types';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { localDispatch, liveSnapshot, spyDispatch } from '../helpers/storeTestHelpers';

// Helpers

/** The store's real dispatch, captured before any test swaps in a spy via `spyDispatch`. */
const realDispatch = useStore.getState().dispatch;

function resetStore(): void {
  useStore.setState({ dispatch: realDispatch });
  // Also clears local-edit bookkeeping so a local edit in one test can't block the next hydrate.
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ lastSummary: null });
}

/**
 * Inject FeatureStep items directly into the store document.
 * This is acceptable for test fixtures (not entity mutation).
 */
function setHistory(steps: FeatureStep[]): void {
  const doc = useStore.getState().document;
  useStore.getState().hydrateLiveDocument(liveSnapshot({ ...doc, featureHistory: steps }));
}

function makeStep(id: string, name: string, suppressed?: boolean, label?: string): FeatureStep {
  return { id, name, params: {}, ...(suppressed !== undefined ? { suppressed } : {}), ...(label !== undefined ? { label } : {}) };
}

// Tests

function expectBoxSize(size: number[]): void {
  const box = Object.values(useStore.getState().document.entities).find((e) => e?.kind === 'box');
  expect(box?.kind === 'box' ? box.size : null).toEqual(size);
}

describe('FeatureHistoryPanel — rendering', () => {
  beforeEach(() => {
    resetStore();
  });
  it('shows empty message when there are no history steps', () => {
    render(<FeatureHistoryPanel />);
    expect(screen.getByText(/no history steps yet/i)).toBeDefined();
  });
  it('renders one row per history step', () => {
    setHistory([makeStep('s1', 'add_box'), makeStep('s2', 'add_sphere')]);
    render(<FeatureHistoryPanel />);
    expect(screen.getByTestId('history-step-s1')).toBeDefined();
    expect(screen.getByTestId('history-step-s2')).toBeDefined();
  });
  it('shows the command name for each step', () => {
    setHistory([makeStep('s1', 'draw_polyline')]);
    render(<FeatureHistoryPanel />);
    expect(screen.getByText('draw_polyline')).toBeDefined();
  });
  it('shows the optional label when a step has one', () => {
    setHistory([makeStep('s1', 'add_box', false, 'Base plate')]);
    render(<FeatureHistoryPanel />);
    expect(screen.getByText('Base plate')).toBeDefined();
  });
  it('shows step count in the header', () => {
    setHistory([makeStep('s1', 'add_box'), makeStep('s2', 'add_cylinder')]);
    render(<FeatureHistoryPanel />);
    expect(screen.getByLabelText(/2 steps/i)).toBeDefined();
  });
  it('renders a suppress toggle button per step', () => {
    setHistory([makeStep('s1', 'add_box')]);
    render(<FeatureHistoryPanel />);
    const btns = screen.getAllByRole('button', { name: /suppress step|restore step/i });
    expect(btns.length).toBeGreaterThanOrEqual(1);
  });
  it('suppressed step has aria-pressed=true on the suppress button', () => {
    setHistory([makeStep('s1', 'add_box', true)]);
    render(<FeatureHistoryPanel />);
    const btn = screen.getByRole('button', { name: /restore step/i }) as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('FeatureHistoryPanel — toggle suppress', () => {
  beforeEach(() => {
    resetStore();
  });
  it('dispatches set_step_suppressed with suppressed=true when active step is clicked', () => {
    setHistory([makeStep('step-abc', 'add_box', false)]);
    const dispatchSpy = spyDispatch();
    render(<FeatureHistoryPanel />);
    const suppressBtn = screen.getByRole('button', { name: /suppress step add_box/i });
    fireEvent.click(suppressBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('set_step_suppressed', { stepId: 'step-abc', suppressed: true });
  });
  it('dispatches set_step_suppressed with suppressed=false when suppressed step is clicked', () => {
    setHistory([makeStep('step-xyz', 'add_cylinder', true)]);
    const dispatchSpy = spyDispatch();
    render(<FeatureHistoryPanel />);
    const restoreBtn = screen.getByRole('button', { name: /restore step add_cylinder/i });
    fireEvent.click(restoreBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('set_step_suppressed', { stepId: 'step-xyz', suppressed: false });
  });
});

describe('FeatureHistoryPanel — reorder', () => {
  beforeEach(() => {
    resetStore();
  });
  it.each([
    ['newIndex=0 when move-up clicked on index 1', 's1', /move step add_sphere up/i, 0],
    ['newIndex=1 when move-down clicked on index 0', 's0', /move step add_box down/i, 1],
  ])('dispatches reorder_step with %s', (_title, stepId, buttonName, newIndex) => {
    setHistory([makeStep('s0', 'add_box'), makeStep('s1', 'add_sphere')]);
    const dispatchSpy = spyDispatch();
    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId(`history-step-${stepId}`);
    fireEvent.click(within(row).getByRole('button', { name: buttonName }));
    expect(dispatchSpy).toHaveBeenCalledWith('reorder_step', { stepId, newIndex });
  });
  it('disables move-up for the first step', () => {
    setHistory([makeStep('s0', 'add_box'), makeStep('s1', 'add_sphere')]);
    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId('history-step-s0');
    const upBtn = within(row).getByRole('button', { name: /move step add_box up/i }) as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });
  it('disables move-down for the last step', () => {
    setHistory([makeStep('s0', 'add_box'), makeStep('s1', 'add_sphere')]);
    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId('history-step-s1');
    const downBtn = within(row).getByRole('button', { name: /move step add_sphere down/i }) as HTMLButtonElement;
    expect(downBtn.disabled).toBe(true);
  });
});

describe('FeatureHistoryPanel — delete step', () => {
  beforeEach(() => {
    resetStore();
  });
  it('dispatches delete_step with the correct stepId', () => {
    setHistory([makeStep('del-me', 'add_box')]);
    const dispatchSpy = spyDispatch();
    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId('history-step-del-me');
    const delBtn = within(row).getByRole('button', { name: /delete step add_box/i });
    fireEvent.click(delBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('delete_step', { stepId: 'del-me' });
  });
});

describe('FeatureHistoryPanel — replay', () => {
  beforeEach(() => {
    resetStore();
  });
  it('dispatches replay_history when Replay button is clicked', () => {
    setHistory([makeStep('s1', 'add_box')]);
    const dispatchSpy = spyDispatch();
    render(<FeatureHistoryPanel />);
    const replayBtn = screen.getByRole('button', { name: /replay feature history/i });
    fireEvent.click(replayBtn);
    expect(dispatchSpy).toHaveBeenCalledWith('replay_history', {});
  });
  it('Replay button is disabled when history is empty', () => {
    render(<FeatureHistoryPanel />);
    const replayBtn = screen.getByRole('button', { name: /replay feature history/i }) as HTMLButtonElement;
    expect(replayBtn.disabled).toBe(true);
  });
  it('Replay button is enabled when history has at least one step', () => {
    setHistory([makeStep('s1', 'add_box')]);
    render(<FeatureHistoryPanel />);
    const replayBtn = screen.getByRole('button', { name: /replay feature history/i }) as HTMLButtonElement;
    expect(replayBtn.disabled).toBe(false);
  });
});

describe('FeatureHistoryPanel — live dispatch (integration smoke)', () => {
  beforeEach(() => {
    resetStore();
  });
  it('populates the history panel when a box is added via localDispatch', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    render(<FeatureHistoryPanel />);
    // After an add_box command, featureHistory should have 1+ steps.
    const steps = screen.getAllByRole('listitem');
    expect(steps.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FeatureHistoryPanel — per-step params editor', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ liveStatus: 'disconnected' });
  });
  function openEditor(): HTMLElement {
    localDispatch('add_box', { size: [2, 2, 2] });
    render(<FeatureHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /edit parameters of step add_box/i }));
    return screen.getByRole('form', { name: /add box parameters/i });
  }
  it('opens the param form pre-filled with the recorded params', () => {
    const form = openEditor();
    expect((within(form).getByLabelText(/^Size/) as HTMLInputElement).value).toBe('2, 2, 2');
  });
  it('applies edited params through edit_step_params and closes the form', () => {
    const form = openEditor();
    fireEvent.change(within(form).getByLabelText(/^Size/), { target: { value: '4, 5, 6' } });
    fireEvent.click(within(form).getByRole('button', { name: /^Apply/ }));
    expectBoxSize([4, 5, 6]);
    expect(screen.queryByRole('form', { name: /add box parameters/i })).toBeNull();
  });
  it('keeps the form open and shows the command refusal summary when the edit is rejected', () => {
    const form = openEditor();
    fireEvent.change(within(form).getByLabelText(/^Size/), { target: { value: '0, 0, 0' } });
    fireEvent.click(within(form).getByRole('button', { name: /^Apply/ }));
    expect(screen.getByRole('form', { name: /add box parameters/i })).toBeDefined();
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent ?? '');
    expect(alerts.some((text) => /changed nothing when replayed/.test(text))).toBe(true);
    expectBoxSize([2, 2, 2]);
  });
  it('dispatches a schema-invalid edit and shows the core refusal instead of pre-validating', () => {
    const form = openEditor();
    fireEvent.change(within(form).getByLabelText(/^Size/), { target: { value: '1, 2' } });
    fireEvent.click(within(form).getByRole('button', { name: /^Apply/ }));
    expect(screen.getByRole('form', { name: /add box parameters/i })).toBeDefined();
    expectBoxSize([2, 2, 2]);
  });
  it('Cancel closes the editor without dispatching', () => {
    const form = openEditor();
    fireEvent.click(within(form).getByRole('button', { name: /cancel editing/i }));
    expect(screen.queryByRole('form', { name: /add box parameters/i })).toBeNull();
  });
});
