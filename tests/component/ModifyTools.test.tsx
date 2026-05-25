/**
 * Component tests for <ModifyTools />.
 *
 * Asserts observable behavior: buttons rendered, accessible labels,
 * active state, hint text, and the value-entry UI — not geometry math (W3/R11).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModifyTools } from '../../src/ui/viewport/2d/ModifyTools';
import type { ModifyToolKind, ModifyToolPhase } from '../../src/ui/viewport/2d/useModifyTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderModifyTools(
  overrides: Partial<{
    activeTool: ModifyToolKind;
    phase: ModifyToolPhase;
    pendingValue: number;
    onSelectTool: (t: ModifyToolKind) => void;
    onSetValue: (v: number) => void;
    onCommitValue: () => void;
  }> = {},
): void {
  const props = {
    activeTool: 'none' as ModifyToolKind,
    phase: 'idle' as ModifyToolPhase,
    pendingValue: 1,
    onSelectTool: vi.fn(),
    onSetValue: vi.fn(),
    onCommitValue: vi.fn(),
    ...overrides,
  };
  render(<ModifyTools {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModifyTools', () => {
  it('renders a toolbar with aria-label "2D modify tools"', () => {
    renderModifyTools();
    expect(screen.getByRole('toolbar', { name: '2D modify tools' })).toBeInTheDocument();
  });

  it('renders buttons for all 6 modify tools', () => {
    renderModifyTools();
    expect(screen.getByRole('button', { name: 'Offset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fillet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chamfer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trim' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Extend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explode' })).toBeInTheDocument();
  });

  it('each button has a title attribute with the tool label and keyboard hint', () => {
    renderModifyTools();
    expect(screen.getByRole('button', { name: 'Offset' })).toHaveAttribute('title', 'Offset (O)');
    expect(screen.getByRole('button', { name: 'Fillet' })).toHaveAttribute('title', 'Fillet (F)');
    expect(screen.getByRole('button', { name: 'Trim' })).toHaveAttribute('title', 'Trim (T)');
    expect(screen.getByRole('button', { name: 'Extend' })).toHaveAttribute('title', 'Extend (X)');
    expect(screen.getByRole('button', { name: 'Explode' })).toHaveAttribute('title', 'Explode (E)');
  });

  it('active tool button has aria-pressed=true, others have aria-pressed=false', () => {
    renderModifyTools({ activeTool: 'trim', phase: 'pick-entity' });
    expect(screen.getByRole('button', { name: 'Trim' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Offset' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('active button gets the --active CSS class', () => {
    renderModifyTools({ activeTool: 'offset', phase: 'pick-entity' });
    const btn = screen.getByRole('button', { name: 'Offset' });
    expect(btn.className).toContain('draw-tool-btn--active');
  });

  it('no --active class when no tool is active', () => {
    renderModifyTools({ activeTool: 'none' });
    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      expect(btn.className).not.toContain('draw-tool-btn--active');
    }
  });

  it('calls onSelectTool with the tool kind when a button is clicked (inactive → active)', () => {
    const onSelectTool = vi.fn();
    renderModifyTools({ activeTool: 'none', onSelectTool });
    fireEvent.click(screen.getByRole('button', { name: 'Fillet' }));
    expect(onSelectTool).toHaveBeenCalledWith('fillet');
  });

  it('calls onSelectTool with "none" when the active tool button is clicked (toggle off)', () => {
    const onSelectTool = vi.fn();
    renderModifyTools({ activeTool: 'offset', phase: 'pick-entity', onSelectTool });
    fireEvent.click(screen.getByRole('button', { name: 'Offset' }));
    expect(onSelectTool).toHaveBeenCalledWith('none');
  });

  it('shows pick-entity hint for the offset tool', () => {
    renderModifyTools({ activeTool: 'offset', phase: 'pick-entity' });
    expect(screen.getByRole('status')).toHaveTextContent('Click an entity to offset');
  });

  it('shows pick-entity hint for the trim tool', () => {
    renderModifyTools({ activeTool: 'trim', phase: 'pick-entity' });
    expect(screen.getByRole('status')).toHaveTextContent('Click the line to trim');
  });

  it('shows pick-boundary hint for trim tool in pick-boundary phase', () => {
    renderModifyTools({ activeTool: 'trim', phase: 'pick-boundary' });
    expect(screen.getByRole('status')).toHaveTextContent('Click the boundary line');
  });

  it('shows pick-entity hint for the explode tool', () => {
    renderModifyTools({ activeTool: 'explode', phase: 'pick-entity' });
    expect(screen.getByRole('status')).toHaveTextContent('Click a polyline to explode');
  });

  it('does not show a hint when no tool is active', () => {
    renderModifyTools({ activeTool: 'none', phase: 'idle' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows value input and Apply button in enter-value phase', () => {
    renderModifyTools({ activeTool: 'offset', phase: 'enter-value', pendingValue: 2.5 });
    expect(screen.getByRole('spinbutton', { name: 'Distance value' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('does not show value input outside enter-value phase', () => {
    renderModifyTools({ activeTool: 'offset', phase: 'pick-entity' });
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('calls onSetValue when the numeric input changes', () => {
    const onSetValue = vi.fn();
    renderModifyTools({ activeTool: 'offset', phase: 'enter-value', pendingValue: 1, onSetValue });
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '3.5' } });
    expect(onSetValue).toHaveBeenCalledWith(3.5);
  });

  it('calls onCommitValue when Enter is pressed in the input', () => {
    const onCommitValue = vi.fn();
    renderModifyTools({ activeTool: 'offset', phase: 'enter-value', pendingValue: 1, onCommitValue });
    const input = screen.getByRole('spinbutton');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommitValue).toHaveBeenCalled();
  });

  it('calls onCommitValue when the Apply button is clicked', () => {
    const onCommitValue = vi.fn();
    renderModifyTools({ activeTool: 'fillet', phase: 'enter-value', pendingValue: 1, onCommitValue });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onCommitValue).toHaveBeenCalled();
  });

  it('shows "Radius" label for fillet tool in enter-value phase', () => {
    renderModifyTools({ activeTool: 'fillet', phase: 'enter-value' });
    expect(screen.getByRole('spinbutton', { name: 'Radius value' })).toBeInTheDocument();
  });

  it('shows pick-vertex hint for fillet tool in pick-vertex phase', () => {
    renderModifyTools({ activeTool: 'fillet', phase: 'pick-vertex' });
    expect(screen.getByRole('status')).toHaveTextContent('Click near a vertex to fillet');
  });

  it('shows enter-value hint for chamfer tool in enter-value phase', () => {
    renderModifyTools({ activeTool: 'chamfer', phase: 'enter-value' });
    expect(screen.getByRole('status')).toHaveTextContent('Enter chamfer distance');
  });
});
