import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { getCommand } from '@core/commands/registry';
import { CommandParamForm } from '@ui/components/commandPalette/CommandParamForm';
import { optionLabel } from '@ui/components/commandPalette/paramForm';

describe('CommandParamForm enum typeahead', () => {
  function unitsSelect(): HTMLSelectElement {
    render(<CommandParamForm command={getCommand('set_units')!} onBack={() => undefined} onSubmit={() => undefined} />);
    return screen.getByLabelText(/^Units/) as HTMLSelectElement;
  }
  it('typing "m" selects "m", not "mm"', () => {
    const select = unitsSelect();
    fireEvent.keyDown(select, { key: 'm' });
    expect(select.value).toBe('m');
  });
  it('typing "mm" quickly selects "mm" and "c" selects the first c option', () => {
    const select = unitsSelect();
    fireEvent.keyDown(select, { key: 'm' });
    fireEvent.keyDown(select, { key: 'm' });
    expect(select.value).toBe('mm');
    fireEvent.keyDown(select, { key: 'x' });
    expect(select.value).toBe('mm');
  });
  it('shows snake_case options as words and matches typing against them, keeping the values', () => {
    render(<CommandParamForm command={getCommand('create_analysis')!} onBack={() => undefined} onSubmit={() => undefined} />);
    const select = screen.getByLabelText(/^Analysis type/) as HTMLSelectElement;
    const heatSteady = within(select).getByRole('option', { name: 'Heat steady' }) as HTMLOptionElement;
    expect(heatSteady.value).toBe('heat_steady');
    fireEvent.keyDown(select, { key: 'h' });
    fireEvent.keyDown(select, { key: 'e' });
    expect(select.value).toBe('heat_steady');
  });
  it('keeps unit options verbatim', () => {
    const select = unitsSelect();
    expect(within(select).getByRole('option', { name: 'mm' })).toBeDefined();
  });
});

describe('optionLabel', () => {
  it.each([
    ['heat_steady', 'Heat steady'],
    ['true', 'Yes'],
    ['false', 'No'],
    ['mm', 'mm'],
    ['+x', '+x'],
    ['M10', 'M10'],
    ['export_stl', 'Export STL'],
  ])('%s -> %s', (option, label) => {
    expect(optionLabel(option)).toBe(label);
  });
});
