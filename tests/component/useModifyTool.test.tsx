/**
 * Component tests for the useModifyTool hook.
 *
 * Asserts observable behavior: phase transitions, cancel correctness, keyboard
 * shortcut activation — not geometry math (W3/R11).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { useModifyTool } from '../../src/ui/viewport/2d/useModifyTool';

// ---------------------------------------------------------------------------
// Store reset helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useModifyTool', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in idle phase with no active tool', () => {
    const { result } = renderHook(() => useModifyTool());
    expect(result.current.activeTool).toBe('none');
    expect(result.current.phase).toBe('idle');
  });

  it('setActiveTool transitions to pick-entity phase', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.setActiveTool('offset');
    });
    expect(result.current.activeTool).toBe('offset');
    expect(result.current.phase).toBe('pick-entity');
  });

  it('setActiveTool("none") resets to idle phase', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.setActiveTool('trim');
    });
    act(() => {
      result.current.setActiveTool('none');
    });
    expect(result.current.activeTool).toBe('none');
    expect(result.current.phase).toBe('idle');
  });

  // -------------------------------------------------------------------------
  // Bug 1 regression: cancel() must return to pick-entity, not idle
  // -------------------------------------------------------------------------

  it('cancel() with an active tool returns to pick-entity (not idle)', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.setActiveTool('offset');
    });
    // Simulate mid-operation: entity has been picked
    act(() => {
      result.current.handleEntityPick('ent-1', [5, 0]);
    });
    expect(result.current.phase).toBe('enter-value');

    // Cancel — should go back to pick-entity, not idle
    act(() => {
      result.current.cancel();
    });
    expect(result.current.phase).toBe('pick-entity');
    expect(result.current.activeTool).toBe('offset');
    expect(result.current.pickedEntityId).toBeNull();
  });

  it('cancel() with no active tool stays in idle', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.cancel();
    });
    expect(result.current.phase).toBe('idle');
  });

  it('Esc key mid-operation with active tool returns to pick-entity (not idle)', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.setActiveTool('trim');
    });
    // Simulate first pick
    act(() => {
      result.current.handleEntityPick('ent-1', [0, 0]);
    });
    expect(result.current.phase).toBe('pick-boundary');

    // Fire Esc
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(result.current.phase).toBe('pick-entity');
    expect(result.current.activeTool).toBe('trim');
  });

  // -------------------------------------------------------------------------
  // Keyboard shortcut activation
  // -------------------------------------------------------------------------

  it('pressing O activates the offset tool', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    });
    expect(result.current.activeTool).toBe('offset');
    expect(result.current.phase).toBe('pick-entity');
  });

  it('pressing the active tool key toggles it off', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.setActiveTool('fillet');
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    });
    expect(result.current.activeTool).toBe('none');
    expect(result.current.phase).toBe('idle');
  });

  it('pressing a shortcut while typing in an input does not activate the tool', () => {
    const { result } = renderHook(() => useModifyTool());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'o', bubbles: true }),
      );
    });
    // Tool should NOT have changed because the event target is an input
    expect(result.current.activeTool).toBe('none');

    document.body.removeChild(input);
  });

  // -------------------------------------------------------------------------
  // Phase transitions for the fillet/chamfer flow
  // -------------------------------------------------------------------------

  it('fillet: pick-entity → pick-vertex → enter-value on handleEntityPick', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => {
      result.current.setActiveTool('fillet');
    });
    // First pick: pick the polyline entity
    act(() => {
      result.current.handleEntityPick('poly-1', [0, 0], [
        [0, 0],
        [10, 0],
        [10, 10],
      ]);
    });
    expect(result.current.phase).toBe('pick-vertex');
    expect(result.current.pickedEntityId).toBe('poly-1');

    // Second pick: pick near a vertex
    act(() => {
      result.current.handleEntityPick('poly-1', [9.5, 0.5], [
        [0, 0],
        [10, 0],
        [10, 10],
      ]);
    });
    expect(result.current.phase).toBe('enter-value');
    expect(result.current.pickedVertexIndex).toBe(1); // [10,0] is nearest to [9.5,0.5]
  });
});
