/**
 * Keyboard shortcut sheet — opened with `?` or the toolbar's Shortcuts button. Content comes from
 * SHORTCUT_GROUPS so it never drifts from the real key handling. Modal: focus is trapped while
 * open and restored to the opener on close. Presentation only.
 */

import React, { useId, useRef } from 'react';
import { useToolStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { SHORTCUT_GROUPS } from '@ui/hooks/shortcuts';
import { ModalDialog } from './ModalDialog';

export function ShortcutsDialog(): React.ReactElement | null {
  const open = useToolStore((s) => s.shortcutsOpen);
  const setOpen = useToolStore((s) => s.setShortcutsOpen);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  if (!open) return null;

  const close = (): void => setOpen(false);

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog"
      onClose={close}
      labelledBy={titleId}
      initialFocus={closeRef}
      onTab={(e) => {
        // The close button is the only focusable control: keep focus trapped on it.
        e.preventDefault();
        closeRef.current?.focus();
      }}
    >
      <div className="shortcuts-dialog__header">
        <h2 id={titleId} className="shortcuts-dialog__title">
          Keyboard shortcuts
        </h2>
        <button ref={closeRef} type="button" className="icon-btn" onClick={close} aria-label="Close shortcuts" title="Close">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="shortcuts-dialog__body">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="shortcuts-group" aria-label={group.title}>
            <h3 className="shortcuts-group__title">{group.title}</h3>
            <dl className="shortcuts-group__list">
              {group.entries.map((entry) => (
                <div key={entry.keys} className="shortcuts-row">
                  <dt>
                    <kbd className="kbd">{entry.keys}</kbd>
                  </dt>
                  <dd>{entry.action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </ModalDialog>
  );
}
