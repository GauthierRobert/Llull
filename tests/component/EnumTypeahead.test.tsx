/**
 * Enum select in the command param form: typing an option's full name selects exactly that option,
 * not the first option sharing the prefix ("m" -> "m", not "mm").
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getCommand } from '@core/commands/registry';
import { CommandParamForm } from '@ui/components/commandPalette/CommandParamForm';

describe('CommandParamForm enum typeahead', () => {
  function unitsSelect(): HTMLSelectElement {
    render(
      <CommandParamForm
        command={getCommand('set_units')!}
        onBack={() => undefined}
        onSubmit={() => undefined}
      />,
    );
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
});
