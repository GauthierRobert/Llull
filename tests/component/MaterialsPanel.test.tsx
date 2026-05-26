/**
 * Component tests for <MaterialsPanel />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel renders "No materials" when document.materials is empty.
 *   - Panel lists each material by name with a color swatch and density.
 *   - The Assign button dispatches 'assign_material' with materialName + entityIds.
 *   - The Assign button is disabled when no entities are selected.
 *   - The create form dispatches 'create_material' with correct params on submit.
 *   - The Create button is disabled until all required fields are valid.
 *   - Form fields are cleared after a successful submit.
 *   - The material count is displayed in the header.
 *
 * No geometry math or internals — behavioral testing only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';
import type { Material } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
  });
}

/** Inject materials directly into the store document for fixture setup. */
function setMaterials(mats: Record<string, Material>): void {
  const doc = useStore.getState().document;
  useStore.getState().hydrateLiveDocument({ ...doc, materials: mats });
}

/** Set the document selection directly (bypasses hydrateLiveDocument entity filter). */
function setSelection(ids: string[]): void {
  const doc = useStore.getState().document;
  useStore.setState({ document: { ...doc, selection: ids } });
}

/** Patch the dispatch action on the store for spy purposes. */
function patchDispatch(spy: ReturnType<typeof vi.fn>): void {
  useStore.setState({ dispatch: spy } as any);
}

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe('MaterialsPanel — rendering', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows empty message when there are no materials', () => {
    render(<MaterialsPanel />);
    expect(screen.getByText(/no materials defined/i)).toBeDefined();
  });

  it('renders a row for each material', () => {
    setMaterials({
      steel: { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.9, roughness: 0.2 },
      pla: { name: 'pla', density: 0.00124, color: '#ff8800', metalness: 0, roughness: 0.7 },
    });

    render(<MaterialsPanel />);

    expect(screen.getByTestId('material-row-steel')).toBeDefined();
    expect(screen.getByTestId('material-row-pla')).toBeDefined();
  });

  it('shows material name in each row', () => {
    setMaterials({
      aluminium: { name: 'aluminium', density: 0.0027, color: '#d4d8e0', metalness: 0.85, roughness: 0.3 },
    });
    render(<MaterialsPanel />);
    expect(screen.getByText('aluminium')).toBeDefined();
  });

  it('shows the material count in the header', () => {
    setMaterials({
      a: { name: 'a', density: 1, color: '#aaaaaa', metalness: 0, roughness: 0.5 },
      b: { name: 'b', density: 2, color: '#bbbbbb', metalness: 0, roughness: 0.5 },
    });
    render(<MaterialsPanel />);
    expect(screen.getByLabelText(/2 materials/i)).toBeDefined();
  });

  it('renders a color swatch for each material', () => {
    setMaterials({
      copper: { name: 'copper', density: 0.00893, color: '#b87333', metalness: 1, roughness: 0.2 },
    });
    render(<MaterialsPanel />);

    const row = screen.getByTestId('material-row-copper');
    const swatch = within(row).getByTitle('#b87333');
    expect(swatch).toBeDefined();
  });

  it('shows the density value in each row', () => {
    setMaterials({
      titanium: { name: 'titanium', density: 0.00445, color: '#c0c4cc', metalness: 0.7, roughness: 0.35 },
    });
    render(<MaterialsPanel />);
    // toPrecision(3) of 0.00445 = "0.00445"
    expect(screen.getByText(/0\.00445/)).toBeDefined();
  });

  it('renders an Assign button per material', () => {
    setMaterials({
      steel: { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.9, roughness: 0.2 },
    });
    render(<MaterialsPanel />);
    expect(screen.getByRole('button', { name: /assign material steel/i })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Assign tests
// ---------------------------------------------------------------------------

describe('MaterialsPanel — assign', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('Assign button is disabled when no entities are selected', () => {
    setMaterials({
      steel: { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.9, roughness: 0.2 },
    });
    render(<MaterialsPanel />);
    const assignBtn = screen.getByRole('button', { name: /assign material steel/i }) as HTMLButtonElement;
    expect(assignBtn.disabled).toBe(true);
  });

  it('Assign button is enabled when entities are selected', () => {
    setMaterials({
      steel: { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.9, roughness: 0.2 },
    });
    setSelection(['entity-1']);
    render(<MaterialsPanel />);
    const assignBtn = screen.getByRole('button', { name: /assign material steel/i }) as HTMLButtonElement;
    expect(assignBtn.disabled).toBe(false);
  });

  it('dispatches assign_material with materialName and entityIds on click', () => {
    setMaterials({
      steel: { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.9, roughness: 0.2 },
    });
    setSelection(['e-abc', 'e-def']);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<MaterialsPanel />);

    const assignBtn = screen.getByRole('button', { name: /assign material steel/i });
    fireEvent.click(assignBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('assign_material', {
      materialName: 'steel',
      entityIds: ['e-abc', 'e-def'],
    });
  });

  it('dispatches with the correct materialName when multiple materials exist', () => {
    setMaterials({
      steel: { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.9, roughness: 0.2 },
      pla: { name: 'pla', density: 0.00124, color: '#ff8800', metalness: 0, roughness: 0.7 },
    });
    setSelection(['e-001']);
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<MaterialsPanel />);

    const assignPla = screen.getByRole('button', { name: /assign material pla/i });
    fireEvent.click(assignPla);

    expect(dispatchSpy).toHaveBeenCalledWith('assign_material', {
      materialName: 'pla',
      entityIds: ['e-001'],
    });
    expect(dispatchSpy).not.toHaveBeenCalledWith('assign_material', {
      materialName: 'steel',
      entityIds: ['e-001'],
    });
  });
});

// ---------------------------------------------------------------------------
// Create form tests
// ---------------------------------------------------------------------------

describe('MaterialsPanel — create form', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders the create form', () => {
    render(<MaterialsPanel />);
    expect(screen.getByTestId('material-create-form')).toBeDefined();
  });

  it('Create button is disabled when name is empty', () => {
    render(<MaterialsPanel />);
    const createBtn = screen.getByRole('button', { name: /create material/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('Create button is disabled when density is empty', () => {
    render(<MaterialsPanel />);
    const form = screen.getByTestId('material-create-form');
    const nameInput = within(form).getByRole('textbox', { name: /new material name/i });
    fireEvent.change(nameInput, { target: { value: 'steel' } });

    const createBtn = screen.getByRole('button', { name: /create material/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('Create button is enabled when name and valid density are filled', () => {
    render(<MaterialsPanel />);
    const form = screen.getByTestId('material-create-form');
    const nameInput = within(form).getByRole('textbox', { name: /new material name/i });
    const densityInput = within(form).getByRole('spinbutton', { name: /material density/i });

    fireEvent.change(nameInput, { target: { value: 'steel' } });
    fireEvent.change(densityInput, { target: { value: '0.00785' } });

    const createBtn = screen.getByRole('button', { name: /create material/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(false);
  });

  it('dispatches create_material with correct params on submit', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<MaterialsPanel />);
    const form = screen.getByTestId('material-create-form');

    const nameInput = within(form).getByRole('textbox', { name: /new material name/i });
    const densityInput = within(form).getByRole('spinbutton', { name: /material density/i });

    fireEvent.change(nameInput, { target: { value: 'aluminium' } });
    fireEvent.change(densityInput, { target: { value: '0.0027' } });
    fireEvent.submit(form);

    expect(dispatchSpy).toHaveBeenCalledWith(
      'create_material',
      expect.objectContaining({
        name: 'aluminium',
        density: 0.0027,
      }),
    );
  });

  it('clears name and density after successful submit', () => {
    const dispatchSpy = vi.fn();
    patchDispatch(dispatchSpy);

    render(<MaterialsPanel />);
    const form = screen.getByTestId('material-create-form');

    const nameInput = within(form).getByRole('textbox', {
      name: /new material name/i,
    }) as HTMLInputElement;
    const densityInput = within(form).getByRole('spinbutton', {
      name: /material density/i,
    }) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'steel' } });
    fireEvent.change(densityInput, { target: { value: '0.00785' } });
    fireEvent.submit(form);

    expect(nameInput.value).toBe('');
    expect(densityInput.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Per-entity PBR resolution test
// ---------------------------------------------------------------------------

describe('MaterialsPanel — per-entity PBR resolution', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('resolves a material row for each material in the document', () => {
    setMaterials({
      brass: { name: 'brass', density: 0.0085, color: '#c8a43a', metalness: 0.8, roughness: 0.25 },
    });
    render(<MaterialsPanel />);
    // The row for "brass" should be present and show its data
    const row = screen.getByTestId('material-row-brass');
    expect(row).toBeDefined();
    expect(within(row).getByText('brass')).toBeDefined();
  });
});
