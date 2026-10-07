/** The modify value input must let the user type decimals (0.5) without it being rewritten. */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModifyTools } from '@ui/viewport/2d/ModifyTools';

function renderTools(
  pendingValue: number,
  onSetValue: (value: number) => void,
): ReturnType<typeof render> {
  return render(
    <ModifyTools
      activeTool="fillet"
      phase="enter-value"
      pendingValue={pendingValue}
      onSelectTool={vi.fn()}
      onSetValue={onSetValue}
      onCommitValue={vi.fn()}
    />,
  );
}

describe('ModifyTools value input', () => {
  it('keeps what the user typed when the pending value round-trips through the parent', () => {
    const onSetValue = vi.fn();
    const view = renderTools(1, onSetValue);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(onSetValue).toHaveBeenLastCalledWith(0.5);
    // The parent re-renders with the intermediate value the user passed through (0).
    view.rerender(
      <ModifyTools
        activeTool="fillet"
        phase="enter-value"
        pendingValue={0}
        onSelectTool={vi.fn()}
        onSetValue={onSetValue}
        onCommitValue={vi.fn()}
      />,
    );
    expect(input.value).toBe('0.5');
  });
});
