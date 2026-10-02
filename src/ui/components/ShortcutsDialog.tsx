/**
 * @layer ui/components
 *
 * Keyboard shortcut sheet — opened with `?` or the toolbar's Shortcuts button. Content comes from
 * SHORTCUT_GROUPS so it never drifts from the real key handling. Presentation only.
 */

import React, { useEffect, useId, useRef } from 'react';
import { useToolStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { SHORTCUT_GROUPS } from '@ui/hooks/shortcuts';

export function ShortcutsDialog(): React.ReactElement | null {
  const open = useToolStore((s) => s.shortcutsOpen);
  const setOpen = useToolStore((s) => s.setShortcutsOpen);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = (): void => setOpen(false);

  return (
    <div
      className="shortcuts-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="shortcuts-dialog__header">
          <h2 id={titleId} className="shortcuts-dialog__title">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            onClick={close}
            aria-label="Close shortcuts"
            title="Close"
          >
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
      </div>
    </div>
  );
}
