/**
 * ConfirmDialog accessibility contract: focus lands on Cancel, Tab is trapped inside the dialog,
 * Escape / backdrop cancel, focus returns to the opener on close.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '@ui/components/ConfirmDialog';

function setup(): { onConfirm: () => void; onCancel: () => void } {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Delete project"
      message="This cannot be undone."
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('is a named modal dialog with focus on Cancel', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Delete project' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('confirms and cancels through its buttons', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape and on backdrop click, not on dialog click', () => {
    const { onCancel } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('returns focus to the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <ConfirmDialog
        title="t"
        message="m"
        confirmLabel="Ok"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
