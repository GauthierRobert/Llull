/**
 * Component tests for <PropertiesPanel /> and <ParamForm />.
 *
 * Asserts observable behavior:
 *   - Selection section reflects the store's document.selection.
 *   - Picking a command + filling ParamForm + submitting dispatches with parsed params.
 *   - Array parsing converts "2,3,4" → [2, 3, 4].
 *
 * (workflow W3, react R11 — behavior only, no internals or geometry math)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { ParamForm } from '@ui/panels/ParamForm';
import type { ParamsSchema } from '@core/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

/** Create a box entity via the store dispatch, return its id. */
function createBox(size: [number, number, number] = [2, 2, 2]): string {
  const result = useStore.getState().dispatch('add_box', { size });
  return result.affected[0]!;
}

// ---------------------------------------------------------------------------
// ParamForm unit-level component tests
// ---------------------------------------------------------------------------

describe('ParamForm', () => {
  const schema: ParamsSchema = {
    type: 'object',
    properties: {
      size: { type: 'array', description: 'Width, height, depth', items: { type: 'number' } },
      color: { type: 'string', description: 'Hex color' },
    },
    required: ['size'],
  };

  it('renders a labeled input for each schema property', () => {
    render(<ParamForm schema={schema} onSubmit={() => undefined} />);

    expect(screen.getByLabelText(/size/i)).toBeDefined();
    expect(screen.getByLabelText(/color/i)).toBeDefined();
  });

  it('marks required fields with an asterisk', () => {
    render(<ParamForm schema={schema} onSubmit={() => undefined} />);

    // The label for "size" should contain a visual asterisk
    const sizeInput = screen.getByLabelText(/size/i);
    expect(sizeInput).toBeDefined();
    // The label element closest to the input; asterisk is in its text content
    const label = sizeInput.closest('.param-field')?.querySelector('label');
    expect(label?.textContent).toContain('*');
  });

  it('parses array input "2,3,4" as [2, 3, 4] when submitted', () => {
    const collected: unknown[] = [];
    render(
      <ParamForm
        schema={schema}
        onSubmit={(params) => collected.push(params)}
      />,
    );

    const sizeInput = screen.getByLabelText(/size/i);
    fireEvent.change(sizeInput, { target: { value: '2,3,4' } });

    const btn = screen.getByRole('button', { name: /run/i });
    fireEvent.click(btn);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ size: [2, 3, 4] });
  });

  it('parses space-separated array input "1 2 3" as [1, 2, 3]', () => {
    const collected: unknown[] = [];
    render(<ParamForm schema={schema} onSubmit={(params) => collected.push(params)} />);

    const sizeInput = screen.getByLabelText(/size/i);
    fireEvent.change(sizeInput, { target: { value: '1 2 3' } });

    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    expect((collected[0] as Record<string, unknown>)['size']).toEqual([1, 2, 3]);
  });

  it('blocks submit and shows error when a required field is empty', () => {
    const collected: unknown[] = [];
    render(<ParamForm schema={schema} onSubmit={(params) => collected.push(params)} />);

    // Leave "size" (required) empty
    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    expect(collected).toHaveLength(0);
    // An error message should appear
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('skips optional empty fields in the submitted params', () => {
    const collected: unknown[] = [];
    render(<ParamForm schema={schema} onSubmit={(params) => collected.push(params)} />);

    const sizeInput = screen.getByLabelText(/size/i);
    fireEvent.change(sizeInput, { target: { value: '2,2,2' } });
    // leave color empty

    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    expect(collected).toHaveLength(1);
    const params = collected[0] as Record<string, unknown>;
    expect(params['size']).toEqual([2, 2, 2]);
    // color not included (optional + empty)
    expect('color' in params).toBe(false);
  });

  it('resets the form after a successful submit', () => {
    render(<ParamForm schema={schema} onSubmit={() => undefined} />);

    const sizeInput = screen.getByLabelText(/size/i) as HTMLInputElement;
    fireEvent.change(sizeInput, { target: { value: '1,2,3' } });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    expect(sizeInput.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// PropertiesPanel tests
// ---------------------------------------------------------------------------

describe('PropertiesPanel', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows "No entity selected" when nothing is selected', () => {
    render(<PropertiesPanel />);
    expect(screen.getByText(/no entity selected/i)).toBeDefined();
  });

  it('shows entity kind and id when a single entity is selected', () => {
    const id = createBox();
    useStore.getState().select([id]);

    render(<PropertiesPanel />);

    expect(screen.getByText('box')).toBeDefined();
    expect(screen.getByText(id)).toBeDefined();
  });

  it('shows a summary count for multiple selections', () => {
    const id1 = createBox();
    const id2 = createBox([3, 3, 3]);
    useStore.getState().select([id1, id2]);

    render(<PropertiesPanel />);

    expect(screen.getByText(/2 entities selected/i)).toBeDefined();
  });

  it('renders the Run Command section with a command selector', () => {
    render(<PropertiesPanel />);
    // The command picker is a <select> (combobox role)
    expect(screen.getByRole('combobox')).toBeDefined();
  });

  it('selecting add_box and submitting size creates a box entity', () => {
    render(<PropertiesPanel />);

    // Select add_box in the dropdown
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'add_box' } });

    // Fill in the size field
    const sizeInput = screen.getByLabelText(/size/i);
    fireEvent.change(sizeInput, { target: { value: '3,4,5' } });

    // Submit
    const runBtn = screen.getByRole('button', { name: /run add box/i });
    fireEvent.click(runBtn);

    const { document } = useStore.getState();
    expect(document.order).toHaveLength(1);
    const entity = document.entities[document.order[0]!];
    expect(entity?.kind).toBe('box');
    // size should be [3, 4, 5]
    if (entity?.kind === 'box') {
      expect(Array.from(entity.size)).toEqual([3, 4, 5]);
    }
  });

  it('selecting an entity after creation shows its properties', () => {
    const id = createBox([1, 2, 3]);
    useStore.getState().select([id]);

    render(<PropertiesPanel />);

    // Kind should be visible
    expect(screen.getByText('box')).toBeDefined();
    // "Size" label appears in the selection section (within the <dl> list)
    const selectionSection = screen.getByRole('region', { name: /selection/i });
    expect(within(selectionSection).getByText('Size')).toBeDefined();
  });

  it('dispatch with parsed params updates lastSummary', () => {
    render(<PropertiesPanel />);

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'add_box' } });

    const sizeInput = screen.getByLabelText(/size/i);
    fireEvent.change(sizeInput, { target: { value: '2,2,2' } });

    fireEvent.click(screen.getByRole('button', { name: /run add box/i }));

    const { lastSummary } = useStore.getState();
    expect(lastSummary).toBeTruthy();
    expect(lastSummary).toContain('box');
  });
});
