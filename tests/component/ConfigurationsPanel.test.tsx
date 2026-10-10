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

import { liveSnapshot } from '../helpers/storeTestHelpers';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useStore } from '@ui/store';
import { type Configuration, createEmptyDocument } from '@core/model/types';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';

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
  useStore.getState().hydrateLiveDocument(liveSnapshot({ ...doc, configurations: configs }));
}

/** Patch the dispatch action on the store for spy purposes. Tests-only. */
function patchDispatch(spy: ReturnType<typeof vi.fn>): void {
  useStore.setState({ dispatch: spy } as any);
}

function textbox(root: HTMLElement, name: RegExp): HTMLInputElement {
  return within(root).getByRole('textbox', { name }) as HTMLInputElement;
}

/** Type a configuration name into the create form. */
function fillName(form: HTMLElement, value: string): HTMLInputElement {
  const input = textbox(form, /^configuration name$/i);
  fireEvent.change(input, { target: { value } });
  return input;
}

/** Type a parameter name + expression into 1-based `row` of the create form. */
function fillRow(form: HTMLElement, row: number, name: string, expression: string): void {
  fireEvent.change(textbox(form, new RegExp(`parameter name for row ${row}`, 'i')), {
    target: { value: name },
  });
  fireEvent.change(textbox(form, new RegExp(`expression for row ${row}`, 'i')), {
    target: { value: expression },
  });
}

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe('ConfigurationsPanel — rendering', () => {
  beforeEach(() => {
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
    resetStore();
  });

  it('renders the create form', () => {
    render(<ConfigurationsPanel />);
    expect(screen.getByTestId('config-create-form')).toBeDefined();
  });

  it('Create button is disabled when name is empty', () => {
    render(<ConfigurationsPanel />);
    const createBtn = screen.getByRole('button', {
      name: /create configuration/i,
    }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('Create button remains disabled when only the name is filled', () => {
    render(<ConfigurationsPanel />);
    const nameInput = screen.getByRole('textbox', { name: /^configuration name$/i });
    fireEvent.change(nameInput, { target: { value: 'myconfig' } });

    const createBtn = screen.getByRole('button', {
      name: /create configuration/i,
    }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('Create button is enabled when name and one param row are filled', () => {
    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    fillName(form, 'myconfig');
    fillRow(form, 1, 'w', '20');

    const createBtn = screen.getByRole('button', {
      name: /create configuration/i,
    }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(false);
  });

  it('dispatches create_configuration with name and parameterValues on submit', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    fillName(form, 'compact');
    fillRow(form, 1, 'width', '30');
    fireEvent.submit(form);

    expect(dispatchSpy).toHaveBeenCalledWith(
      'create_configuration',
      { name: 'compact', parameterValues: { width: '30' } },
      expect.anything(),
    );
  });

  it('dispatches create_configuration with multiple parameter rows', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    fillName(form, 'full');
    fillRow(form, 1, 'w', '40');

    // Add second row
    fireEvent.click(screen.getByRole('button', { name: /add parameter row/i }));
    fillRow(form, 2, 'h', '20');

    fireEvent.submit(form);

    expect(dispatchSpy).toHaveBeenCalledWith(
      'create_configuration',
      {
        name: 'full',
        parameterValues: { w: '40', h: '20' },
      },
      expect.anything(),
    );
  });

  it('clears form fields after successful submit', () => {
    const dispatchSpy = vi.fn(
      (_name: string, _params: unknown, options?: { onResult?: (r: unknown) => void }) =>
        options?.onResult?.({ summary: 'ok', changed: true }),
    );
    patchDispatch(dispatchSpy);

    render(<ConfigurationsPanel />);

    const form = screen.getByTestId('config-create-form');
    const nameInput = fillName(form, 'temp');
    fillRow(form, 1, 'r', '5');
    fireEvent.submit(form);

    // The reset row is a fresh React key, so re-query rather than reuse the old elements.
    expect(nameInput.value).toBe('');
    expect(textbox(form, /parameter name for row 1/i).value).toBe('');
    expect(textbox(form, /expression for row 1/i).value).toBe('');
  });
});

describe('ConfigurationsPanel — rejected create', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps the typed values when the command was rejected', () => {
    patchDispatch(
      vi.fn((_name: string, _params: unknown, options?: { onResult?: (r: unknown) => void }) =>
        options?.onResult?.({ summary: 'rejected', changed: false }),
      ),
    );
    render(<ConfigurationsPanel />);
    const form = screen.getByTestId('config-create-form');
    const nameInput = fillName(form, 'keep');
    fillRow(form, 1, 'r', '5');
    fireEvent.submit(form);
    expect(nameInput.value).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// Add / remove parameter rows
// ---------------------------------------------------------------------------

describe('ConfigurationsPanel — parameter row management', () => {
  beforeEach(() => {
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

describe('ConfigurationsPanel — active configuration', () => {
  beforeEach(() => {
    resetStore();
  });

  it('marks the configuration whose parameter expressions are all applied', () => {
    const doc = useStore.getState().document;
    useStore.getState().hydrateLiveDocument(
      liveSnapshot({
        ...doc,
        parameters: { w: { name: 'w', expression: '10', value: 10 } },
        configurations: {
          small: { name: 'small', parameterValues: { w: '5' } },
          large: { name: 'large', parameterValues: { w: '10' } },
        },
      }),
    );
    render(<ConfigurationsPanel />);
    expect(screen.getByTestId('config-row-large')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('config-row-large').textContent).toContain('active');
    expect(screen.getByTestId('config-row-small')).not.toHaveAttribute('aria-current');
  });
});
