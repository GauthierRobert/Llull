/**
 * Component tests for <ConfigurationsPanel />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel renders "No configurations" when document.configurations is empty.
 *   - Panel lists each configuration by name.
 *   - Each configuration row shows its parameter→expression pairs.
 *   - The "Activate" button dispatches 'activate_configuration' with the correct name.
 *   - The create form dispatches 'create_configuration' on submit with name + parameterValues.
 *   - The Create button is disabled until a name and at least one valid param row are filled.
 *   - Form fields are cleared after a successful submit.
 *   - The "+ param" button adds a parameter row.
 *   - The remove-row button removes a row when more than one exists.
 *
 * No geometry math or internals — behavioral testing only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';
import type { Configuration } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
  });
}

/** Inject configurations directly into the store document for fixture setup. */
function setConfigurations(configs: Record<string, Configuration>): void {
  const doc = useStore.getState().document;
  useStore.getState().hydrateLiveDocument({ ...doc, configurations: configs });
}

/** Patch the dispatch action on the store for spy purposes. Tests-only. */
function patchDispatch(spy: ReturnType<typeof vi.fn>): void {
  useStore.setState({ dispatch: spy } as any);
}

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe('ConfigurationsPanel — rendering', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows empty message when there are no configurations', () => {
    render(<ConfigurationsPanel />);
    expect(screen.getByText(/no configurations defined/i)).toBeDefined();
  });

  it('renders a row for each configuration', () => {
    setConfigurations({
      small: { name: 'small', parameterValues: { w: '10' } },
      large: { name: 'large', parameterValues: { w: '40' } },
    });

    render(<ConfigurationsPanel />);

    expect(screen.getByTestId('config-row-small')).toBeDefined();
    expect(screen.getByTestId('config-row-large')).toBeDefined();
  });

  it('shows configuration name in each row', () => {
    setConfigurations({
      production: { name: 'production', parameterValues: { depth: '20' } },
    });
    render(<ConfigurationsPanel />);
    expect(screen.getByText('production')).toBeDefined();
  });

  it('shows parameter→expression pairs inside each row', () => {
    setConfigurations({
      test: { name: 'test', parameterValues: { width: '15', height: 'width * 2' } },
    });
    render(<ConfigurationsPanel />);
    expect(screen.getByText('width')).toBeDefined();
    expect(screen.getByText('15')).toBeDefined();
    expect(screen.getByText('height')).toBeDefined();
    expect(screen.getByText('width * 2')).toBeDefined();
  });

  it('shows the configuration count in the header', () => {
    setConfigurations({
      a: { name: 'a', parameterValues: {} },
      b: { name: 'b', parameterValues: {} },
    });
    render(<ConfigurationsPanel />);
    expect(screen.getByLabelText(/2 configurations/i)).toBeDefined();
  });

  it('renders an Activate button per configuration', () => {
    setConfigurations({
      variant: { name: 'variant', parameterValues: { r: '5' } },
    });
    render(<ConfigurationsPanel />);
    expect(screen.getByRole('button', { name: /activate configuration variant/i })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Activate tests
// ---------------------------------------------------------------------------

describe('ConfigurationsPanel — activate', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('dispatches activate_configuration with the correct name when Activate is clicked', () => {
    setConfigurations({
      small: { name: 'small', parameterValues: { w: '10' } },
    });
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const activateBtn = screen.getByRole('button', { name: /activate configuration small/i });
    fireEvent.click(activateBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('activate_configuration', { name: 'small' });
  });

  it('dispatches with the correct name when multiple configurations exist', () => {
    setConfigurations({
      alpha: { name: 'alpha', parameterValues: { x: '1' } },
      beta: { name: 'beta', parameterValues: { x: '2' } },
    });
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const activateBtn = screen.getByRole('button', { name: /activate configuration beta/i });
    fireEvent.click(activateBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('activate_configuration', { name: 'beta' });
    expect(dispatchSpy).not.toHaveBeenCalledWith('activate_configuration', { name: 'alpha' });
  });
});

// ---------------------------------------------------------------------------
// Create form tests
// ---------------------------------------------------------------------------

describe('ConfigurationsPanel — create form', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders the create form', () => {
    render(<ConfigurationsPanel />);
    expect(screen.getByTestId('config-create-form')).toBeDefined();
  });

  it('Create button is disabled when name is empty', () => {
    render(<ConfigurationsPanel />);
    const createBtn = screen.getByRole('button', { name: /create configuration/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('Create button remains disabled when only the name is filled', () => {
    render(<ConfigurationsPanel />);
    const nameInput = screen.getByRole('textbox', { name: /new configuration name/i });
    fireEvent.change(nameInput, { target: { value: 'myconfig' } });

    const createBtn = screen.getByRole('button', { name: /create configuration/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('Create button is enabled when name and one param row are filled', () => {
    render(<ConfigurationsPanel />);

    const nameInput = screen.getByRole('textbox', { name: /new configuration name/i });
    fireEvent.change(nameInput, { target: { value: 'myconfig' } });

    const paramNameInput = screen.getByRole('textbox', { name: /parameter name for row 1/i });
    const exprInput = screen.getByRole('textbox', { name: /expression for row 1/i });
    fireEvent.change(paramNameInput, { target: { value: 'w' } });
    fireEvent.change(exprInput, { target: { value: '20' } });

    const createBtn = screen.getByRole('button', { name: /create configuration/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(false);
  });

  it('dispatches create_configuration with name and parameterValues on submit', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    const nameInput = within(form).getByRole('textbox', { name: /new configuration name/i });
    const paramNameInput = within(form).getByRole('textbox', { name: /parameter name for row 1/i });
    const exprInput = within(form).getByRole('textbox', { name: /expression for row 1/i });

    fireEvent.change(nameInput, { target: { value: 'compact' } });
    fireEvent.change(paramNameInput, { target: { value: 'width' } });
    fireEvent.change(exprInput, { target: { value: '30' } });
    fireEvent.submit(form);

    expect(dispatchSpy).toHaveBeenCalledWith('create_configuration', {
      name: 'compact',
      parameterValues: { width: '30' },
    });
  });

  it('dispatches create_configuration with multiple parameter rows', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    const nameInput = within(form).getByRole('textbox', { name: /new configuration name/i });
    fireEvent.change(nameInput, { target: { value: 'full' } });

    // Fill first row
    const row0Name = within(form).getByRole('textbox', { name: /parameter name for row 1/i });
    const row0Expr = within(form).getByRole('textbox', { name: /expression for row 1/i });
    fireEvent.change(row0Name, { target: { value: 'w' } });
    fireEvent.change(row0Expr, { target: { value: '40' } });

    // Add second row
    const addRowBtn = screen.getByRole('button', { name: /add parameter row/i });
    fireEvent.click(addRowBtn);

    // Fill second row
    const row1Name = within(form).getByRole('textbox', { name: /parameter name for row 2/i });
    const row1Expr = within(form).getByRole('textbox', { name: /expression for row 2/i });
    fireEvent.change(row1Name, { target: { value: 'h' } });
    fireEvent.change(row1Expr, { target: { value: '20' } });

    fireEvent.submit(form);

    expect(dispatchSpy).toHaveBeenCalledWith('create_configuration', {
      name: 'full',
      parameterValues: { w: '40', h: '20' },
    });
  });

  it('clears form fields after successful submit', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    const nameInput = within(form).getByRole('textbox', {
      name: /new configuration name/i,
    }) as HTMLInputElement;
    const paramNameInput = within(form).getByRole('textbox', {
      name: /parameter name for row 1/i,
    }) as HTMLInputElement;
    const exprInput = within(form).getByRole('textbox', {
      name: /expression for row 1/i,
    }) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'temp' } });
    fireEvent.change(paramNameInput, { target: { value: 'r' } });
    fireEvent.change(exprInput, { target: { value: '5' } });
    fireEvent.submit(form);

    expect(nameInput.value).toBe('');
    expect(paramNameInput.value).toBe('');
    expect(exprInput.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Add / remove parameter rows
// ---------------------------------------------------------------------------

describe('ConfigurationsPanel — parameter row management', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('adds a new parameter row when "+ param" is clicked', () => {
    render(<ConfigurationsPanel />);

    // Initially one row
    expect(screen.getByRole('textbox', { name: /parameter name for row 1/i })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: /parameter name for row 2/i })).toBeNull();

    const addRowBtn = screen.getByRole('button', { name: /add parameter row/i });
    fireEvent.click(addRowBtn);

    expect(screen.getByRole('textbox', { name: /parameter name for row 2/i })).toBeDefined();
  });

  it('remove button is absent when there is only one row', () => {
    render(<ConfigurationsPanel />);
    expect(screen.queryByRole('button', { name: /remove parameter row 1/i })).toBeNull();
  });

  it('remove button is present after adding a second row', () => {
    render(<ConfigurationsPanel />);

    const addRowBtn = screen.getByRole('button', { name: /add parameter row/i });
    fireEvent.click(addRowBtn);

    expect(screen.getByRole('button', { name: /remove parameter row 1/i })).toBeDefined();
  });

  it('removes the correct row when remove is clicked', () => {
    render(<ConfigurationsPanel />);

    const addRowBtn = screen.getByRole('button', { name: /add parameter row/i });
    fireEvent.click(addRowBtn);

    // Now 2 rows exist; remove row 1
    const removeBtn = screen.getByRole('button', { name: /remove parameter row 1/i });
    fireEvent.click(removeBtn);

    // Back to 1 row
    expect(screen.getByRole('textbox', { name: /parameter name for row 1/i })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: /parameter name for row 2/i })).toBeNull();
  });
});
