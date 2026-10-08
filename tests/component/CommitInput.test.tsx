/**
 * CommitInput: Enter/blur commits, Esc reverts, and a rejected edit shows the stored value again
 * instead of leaving the bad text in the field.
 */
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CommitInput } from '@ui/panels/propertyFields';

function Harness(): React.ReactElement {
  const [stored, setStored] = useState('2');
  return (
    <>
      <CommitInput
        className="x"
        label="size"
        value={stored}
        onCommit={(raw) => {
          const parsed = Number.parseFloat(raw);
          if (Number.isFinite(parsed)) setStored(String(parsed));
        }}
      />
      <output aria-label="stored">{stored}</output>
    </>
  );
}

function input(): HTMLInputElement {
  return screen.getByLabelText('size') as HTMLInputElement;
}

describe('CommitInput', () => {
  it('commits a valid edit on blur and shows the new stored value', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '0.5' } });
    fireEvent.blur(input());
    expect(screen.getByLabelText('stored').textContent).toBe('0.5');
    expect(input().value).toBe('0.5');
  });

  it('reverts to the stored value when the edit is rejected', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.blur(input());
    expect(screen.getByLabelText('stored').textContent).toBe('2');
    expect(input().value).toBe('2');
  });

  it('Escape reverts the draft without committing', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '9' } });
    // A real Escape blurs the focused field; the blur must not commit the typed draft.
    input().focus();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.getByLabelText('stored').textContent).toBe('2');
    expect(input().value).toBe('2');
  });
});
