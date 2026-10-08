/** The modify value input must let the user type decimals (0.5) without it being rewritten. */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModifyTools } from '@ui/viewport/2d/ModifyTools';

function tools(pendingValue: number, onSetValue: (value: number) => void): React.ReactElement {
  return (
    <ModifyTools
      activeTool="fillet"
      phase="enter-value"
      pendingValue={pendingValue}
      onSelectTool={vi.fn()}
      onSetValue={onSetValue}
      onCommitValue={vi.fn()}
    />
  );
}

describe('ModifyTools value input', () => {
  it('keeps the typed text while the pending value round-trips through the parent', () => {
    const onSetValue = vi.fn();
    const view = render(tools(1, onSetValue));
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    for (const [typed, reported] of [
      ['0', 0],
      ['0.5', 0.5],
      ['0.50', 0.5],
    ] as const) {
      fireEvent.change(input, { target: { value: typed } });
      expect(onSetValue).toHaveBeenLastCalledWith(reported);
      view.rerender(tools(reported, onSetValue));
      expect(input.value).toBe(typed);
    }
  });

  it('shows a reset pending value coming from the parent', () => {
    const view = render(tools(0.5, vi.fn()));
    view.rerender(tools(1, vi.fn()));
    expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('1');
  });

  it('focuses the value input when the enter-value phase opens', () => {
    render(tools(1, vi.fn()));
    expect(document.activeElement).toBe(screen.getByRole('spinbutton'));
  });
});
