// Document Recovery (A-08, FR-DSF-07, FR-DSF-23): lists every recovery slot the backend holds for documents that were open when llull stopped,
// and the offline edits kept on reconnect. Restore loads the slot through `load_document` and re-binds the backend to it; Discard drops it.
// Nothing is restored or removed without a click.

import React, { useEffect, useId, useRef } from 'react';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { useRecoveryStore } from '@ui/store/recoveryStore';
import { fetchRecoverySlot, postRecovery, type RecoverySlotInfo } from '@ui/store/serverCommands';
import { ModalDialog } from './ModalDialog';

const describeSlot = (slot: RecoverySlotInfo): string =>
  `${slot.path ?? 'not saved yet'} - last change ${new Date(slot.changedAt).toLocaleString()} - ${slot.changeCount} change${slot.changeCount === 1 ? '' : 's'}`;

export function RecoveryDialog(): React.ReactElement | null {
  const open = useRecoveryStore((s) => s.open);
  const slots = useRecoveryStore((s) => s.slots);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const ready = useStore((s) => s.liveStatus === 'connected' && s.liveSeq >= 0);
  const offered = useRef(false);

  // Once the backend's first snapshot is in: offer what the previous session left behind.
  useEffect(() => {
    if (!ready) return;
    void useRecoveryStore.getState().refresh(!offered.current); // the dialog opens once per launch; later reconnects only refresh the list
    offered.current = true;
  }, [ready]);

  if (!open || slots.length === 0) return null;

  const restore = (slot: RecoverySlotInfo): void => {
    void fetchRecoverySlot(slot.id).then(
      ({ json }) =>
        useStore.getState().dispatch(
          'load_document',
          { json },
          {
            onResult: ({ changed }) => {
              if (!changed) {
                useStore.getState().setStatusMessage(`Could not restore "${slot.label}"; it was kept for another try`);
                return;
              }
              useSessionStore.getState().markDirty();
              useSessionStore.getState().setRestoredAt(Date.parse(slot.changedAt));
              void postRecovery('adopt', { id: slot.id }).finally(() => useRecoveryStore.getState().remove(slot.id));
            },
          },
        ),
      () => useStore.getState().setStatusMessage(`Could not read the recovery copy of "${slot.label}"`),
    );
  };
  const discard = (slot: RecoverySlotInfo): void => {
    void postRecovery('discard', { id: slot.id }).then(
      () => useRecoveryStore.getState().remove(slot.id),
      () => useStore.getState().setStatusMessage(`Could not discard the recovery copy of "${slot.label}"`),
    );
  };

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog recovery-dialog"
      onClose={() => useRecoveryStore.getState().setOpen(false)}
      labelledBy={titleId}
      initialFocus={closeRef}
    >
      <div className="shortcuts-dialog__header">
        <h2 id={titleId} className="shortcuts-dialog__title">
          Document Recovery
        </h2>
      </div>
      <p className="confirm-dialog__message">
        llull kept these unsaved documents. Restoring one replaces the document that is open now; nothing is removed until you discard it.
      </p>
      <ul className="recovery-dialog__list">
        {slots.map((slot) => (
          <li key={slot.id} className="recovery-dialog__item">
            <div>
              <strong>{slot.label}</strong>
              <div className="recovery-dialog__meta">{describeSlot(slot)}</div>
            </div>
            <div className="recovery-dialog__actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => restore(slot)}>
                Restore
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => discard(slot)}>
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="confirm-dialog__actions">
        <button ref={closeRef} type="button" className="btn btn--ghost" onClick={() => useRecoveryStore.getState().setOpen(false)}>
          Decide later
        </button>
      </div>
    </ModalDialog>
  );
}
