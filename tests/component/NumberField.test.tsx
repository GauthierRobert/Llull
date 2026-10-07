/**
 * NumberField: typed text survives (decimals, exponents, clearing) while a numeric value is owned
 * elsewhere; only finite parsed numbers are reported; external changes still flow in.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NumberField } from '@ui/components/NumberField';

function field(): HTMLInputElement {
  return screen.getByLabelText('amount') as HTMLInputElement;
}

describe('NumberField', () => {
  it('reports parsed numbers and keeps the typed text', () => {
    const onValueChange = vi.fn();
    render(<NumberField aria-label="amount" value={0} onValueChange={onValueChange} />);
    fireEvent.change(field(), { target: { value: '0.5' } });
    expect(onValueChange).toHaveBeenLastCalledWith(0.5);
    expect(field().value).toBe('0.5');
    fireEvent.change(field(), { target: { value: '1e-3' } });
    expect(onValueChange).toHaveBeenLastCalledWith(0.001);
    expect(field().value).toBe('1e-3');
  });

  it('does not report or rewrite a cleared field, so it can be retyped', () => {
    const onValueChange = vi.fn();
    render(<NumberField aria-label="amount" value={7} onValueChange={onValueChange} />);
    fireEvent.change(field(), { target: { value: '' } });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(field().value).toBe('');
  });

  it('adopts an external value change but leaves equivalent typed text alone', () => {
    const { rerender } = render(
      <NumberField aria-label="amount" value={1} onValueChange={() => undefined} />,
    );
    fireEvent.change(field(), { target: { value: '1e-3' } });
    rerender(<NumberField aria-label="amount" value={0.001} onValueChange={() => undefined} />);
    expect(field().value).toBe('1e-3');
    rerender(<NumberField aria-label="amount" value={42} onValueChange={() => undefined} />);
    expect(field().value).toBe('42');
  });
});
