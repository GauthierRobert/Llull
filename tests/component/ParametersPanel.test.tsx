/**
 * Component tests for <ParametersPanel />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel renders "No parameters" when document.parameters is empty.
 *   - Panel lists each parameter: name, expression (as input), evaluated value.
 *   - When a parameter has an error, the error text is displayed and the input
 *     is visually marked as invalid.
 *   - Editing an expression and pressing Enter dispatches 'set_parameter'.
 *   - Pressing Escape cancels the edit (no dispatch).
 *   - The "Add" form dispatches 'set_parameter' on submit.
 *   - The delete button dispatches 'delete_parameter'.
 *
 * No geometry math or internals — behavioral testing only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { ParametersPanel } from '@ui/panels/ParametersPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
  });
}

function addParam(name: string, expression: string): void {
  localDispatch('set_parameter', { name, expression });
}

/** Patch the dispatch action on the store for spy purposes. Tests-only. */
function patchDispatch(spy: ReturnType<typeof vi.fn>): void {
  useStore.setState({ dispatch: spy } as any);
}

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe('ParametersPanel — rendering', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows empty message when there are no parameters', () => {
    render(<ParametersPanel />);
    expect(screen.getByText(/no parameters defined/i)).toBeDefined();
  });

  it('renders a row for each parameter', () => {
    addParam('width', '10');
    addParam('height', '20');

    render(<ParametersPanel />);

    expect(screen.getByTestId('param-row-width')).toBeDefined();
    expect(screen.getByTestId('param-row-height')).toBeDefined();
  });

  it('shows the parameter name in each row', () => {
    addParam('thickness', '5');
    render(<ParametersPanel />);
    expect(screen.getByText('thickness')).toBeDefined();
  });

  it('shows the expression as an input value', () => {
    addParam('radius', '3.14');
    render(<ParametersPanel />);

    const input = screen.getByRole('textbox', { name: /expression for parameter radius/i });
    expect((input as HTMLInputElement).value).toBe('3.14');
  });

  it('shows the evaluated value', () => {
    addParam('side', '7');
    render(<ParametersPanel />);

    const row = screen.getByTestId('param-row-side');
    expect(row.textContent).toContain('7');
  });

  it('renders an error message when a parameter has an error', () => {
    localDispatch('set_parameter', { name: 'derived', expression: 'nonexistent * 2' });
    render(<ParametersPanel />);

    const alerts = screen.getAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('marks the input as aria-invalid when the parameter has an error', () => {
    localDispatch('set_parameter', { name: 'bad', expression: 'missing_ref + 1' });
    render(<ParametersPanel />);

    const input = screen.getByRole('textbox', { name: /expression for parameter bad/i });
    expect((input as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the parameter count in the header', () => {
    addParam('a', '1');
    addParam('b', '2');
    render(<ParametersPanel />);

    expect(screen.getByLabelText(/2 parameters/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Editing expression tests
// ---------------------------------------------------------------------------

describe('ParametersPanel — editing expression', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('dispatches set_parameter when Enter is pressed with a new expression', () => {
    addParam('base', '5');
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const input = screen.getByRole('textbox', { name: /expression for parameter base/i });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(dispatchSpy).toHaveBeenCalledWith('set_parameter', { name: 'base', expression: '10' });
  });

  it('does NOT dispatch when Escape is pressed', () => {
    addParam('x', '1');
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const input = screen.getByRole('textbox', { name: /expression for parameter x/i });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('dispatches set_parameter on blur when expression changed', () => {
    addParam('val', '3');
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const input = screen.getByRole('textbox', { name: /expression for parameter val/i });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.blur(input);

    expect(dispatchSpy).toHaveBeenCalledWith('set_parameter', { name: 'val', expression: '6' });
  });

  it('does NOT dispatch on blur when expression unchanged', () => {
    addParam('unchanged', '42');
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const input = screen.getByRole('textbox', { name: /expression for parameter unchanged/i });
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delete parameter tests
// ---------------------------------------------------------------------------

describe('ParametersPanel — delete parameter', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('dispatches delete_parameter when the delete button is clicked', () => {
    addParam('toDelete', '7');
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const deleteBtn = screen.getByRole('button', { name: /delete parameter toDelete/i });
    fireEvent.click(deleteBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('delete_parameter', { name: 'toDelete' });
  });
});

// ---------------------------------------------------------------------------
// Add parameter form tests
// ---------------------------------------------------------------------------

describe('ParametersPanel — add parameter form', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders an "Add" submit button', () => {
    render(<ParametersPanel />);
    expect(screen.getByRole('button', { name: /add parameter/i })).toBeDefined();
  });

  it('Add button is disabled when the name field is empty', () => {
    render(<ParametersPanel />);
    const addBtn = screen.getByRole('button', { name: /add parameter/i }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('dispatches set_parameter when the add form is submitted', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const form = screen.getByTestId('param-add-form');
    const nameInput = within(form).getByRole('textbox', { name: /new parameter name/i });
    const exprInput = within(form).getByRole('textbox', { name: /new parameter expression/i });

    fireEvent.change(nameInput, { target: { value: 'newParam' } });
    fireEvent.change(exprInput, { target: { value: '15' } });
    fireEvent.submit(form);

    expect(dispatchSpy).toHaveBeenCalledWith('set_parameter', { name: 'newParam', expression: '15' });
  });

  it('clears the form fields after successful submit', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ParametersPanel />);

    const form = screen.getByTestId('param-add-form');
    const nameInput = within(form).getByRole('textbox', { name: /new parameter name/i }) as HTMLInputElement;
    const exprInput = within(form).getByRole('textbox', { name: /new parameter expression/i }) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'p' } });
    fireEvent.change(exprInput, { target: { value: '1' } });
    fireEvent.submit(form);

    expect(nameInput.value).toBe('');
    expect(exprInput.value).toBe('');
  });
});
