import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DeleteButton, ListRow, StatusLine } from '@ui/panels/PanelParts';

describe('ListRow', () => {
  it('selects through its main button and marks the selected / current row', () => {
    const onSelect = vi.fn();
    render(
      <ul>
        <ListRow selected current testId="row" label="Select wall W1" onSelect={onSelect}>
          <span>W1</span>
        </ListRow>
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select wall W1' }));
    expect(onSelect).toHaveBeenCalledOnce();
    const row = screen.getByTestId('row');
    expect(row).toHaveClass('panel__row--selected');
    expect(row).toHaveAttribute('aria-current', 'true');
  });
  it('keeps row actions out of the main button and does not select on delete', () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <ul>
        <ListRow onSelect={onSelect} actions={<DeleteButton label="Delete wall W1" onDelete={onDelete} />}>
          W1
        </ListRow>
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete wall W1' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('StatusLine', () => {
  it('renders a status role with the text and nothing when empty', () => {
    const { rerender } = render(<StatusLine text="Exported" testId="status" />);
    expect(screen.getByRole('status')).toHaveTextContent('Exported');
    rerender(<StatusLine text="" testId="status" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
