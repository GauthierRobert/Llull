/**
 * @layer ui/components
 *
 * ConfirmDialog — small modal asking to confirm a destructive action. Focus moves to the cancel
 * button on open, Tab is trapped, Escape / backdrop cancel, focus returns to the opener on close.
 * Presentation only.
 */

import React, { useId, useRef } from 'react';
import { ModalDialog } from './ModalDialog';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog confirm-dialog"
      onClose={onCancel}
      labelledBy={titleId}
      initialFocus={cancelRef}
    >
      <div className="shortcuts-dialog__header">
        <h2 id={titleId} className="shortcuts-dialog__title">
          {title}
        </h2>
      </div>
      <p className="confirm-dialog__message">{message}</p>
      <div className="confirm-dialog__actions">
        <button ref={cancelRef} type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}
