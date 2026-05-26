/**
 * Component tests for <FeatureHistoryPanel />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel shows "No history steps yet" when featureHistory is empty.
 *   - Panel renders one row per FeatureStep with the command name visible.
 *   - Suppressed steps are rendered with aria-pressed=true on the suppress button.
 *   - Toggle suppress dispatches 'set_step_suppressed' with the correct stepId and suppressed flag.
 *   - Move-up / move-down buttons dispatch 'reorder_step' with the correct stepId and newIndex.
 *   - Delete button dispatches 'delete_step' with the correct stepId.
 *   - Replay button dispatches 'replay_history' with {}.
 *   - Move-up is disabled for the first step; move-down for the last.
 *
 * No geometry math or internals — behavioral testing only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { localDispatch } from '../helpers/storeTestHelpers';
import type { FeatureStep } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
  });
}

/**
 * Inject FeatureStep items directly into the store document.
 * This is acceptable for test fixtures (not entity mutation).
 */
function setHistory(steps: FeatureStep[]): void {
  const doc = useStore.getState().document;
  useStore.getState().hydrateLiveDocument({ ...doc, featureHistory: steps });
}

function makeStep(id: string, name: string, suppressed?: boolean, label?: string): FeatureStep {
  return {
    id,
    name,
    params: {},
    ...(suppressed !== undefined ? { suppressed } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/** Patch the dispatch action on the store for spy purposes. Tests-only. */
function patchDispatch(spy: ReturnType<typeof vi.fn>): void {
  useStore.setState({ dispatch: spy } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeatureHistoryPanel — rendering', () => {
  beforeEach(() => {
    __resetIdCounter();
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
    setHistory([makeStep('s1', 'draw_line')]);
    render(<FeatureHistoryPanel />);
    expect(screen.getByText('draw_line')).toBeDefined();
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
    __resetIdCounter();
    resetStore();
  });

  it('dispatches set_step_suppressed with suppressed=true when active step is clicked', () => {
    setHistory([makeStep('step-abc', 'add_box', false)]);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<FeatureHistoryPanel />);
    const suppressBtn = screen.getByRole('button', { name: /suppress step add_box/i });
    fireEvent.click(suppressBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('set_step_suppressed', {
      stepId: 'step-abc',
      suppressed: true,
    });
  });

  it('dispatches set_step_suppressed with suppressed=false when suppressed step is clicked', () => {
    setHistory([makeStep('step-xyz', 'add_cylinder', true)]);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<FeatureHistoryPanel />);
    const restoreBtn = screen.getByRole('button', { name: /restore step add_cylinder/i });
    fireEvent.click(restoreBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('set_step_suppressed', {
      stepId: 'step-xyz',
      suppressed: false,
    });
  });
});

describe('FeatureHistoryPanel — reorder', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('dispatches reorder_step with newIndex=0 when move-up clicked on index 1', () => {
    setHistory([makeStep('s0', 'add_box'), makeStep('s1', 'add_sphere')]);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId('history-step-s1');
    const upBtn = within(row).getByRole('button', { name: /move step add_sphere up/i });
    fireEvent.click(upBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('reorder_step', { stepId: 's1', newIndex: 0 });
  });

  it('dispatches reorder_step with newIndex=1 when move-down clicked on index 0', () => {
    setHistory([makeStep('s0', 'add_box'), makeStep('s1', 'add_sphere')]);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId('history-step-s0');
    const downBtn = within(row).getByRole('button', { name: /move step add_box down/i });
    fireEvent.click(downBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('reorder_step', { stepId: 's0', newIndex: 1 });
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
    __resetIdCounter();
    resetStore();
  });

  it('dispatches delete_step with the correct stepId', () => {
    setHistory([makeStep('del-me', 'add_box')]);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<FeatureHistoryPanel />);
    const row = screen.getByTestId('history-step-del-me');
    const delBtn = within(row).getByRole('button', { name: /delete step add_box/i });
    fireEvent.click(delBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('delete_step', { stepId: 'del-me' });
  });
});

describe('FeatureHistoryPanel — replay', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('dispatches replay_history when Replay button is clicked', () => {
    setHistory([makeStep('s1', 'add_box')]);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

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
    __resetIdCounter();
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
