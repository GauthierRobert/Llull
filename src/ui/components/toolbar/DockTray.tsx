// One section of the Tools panel: a titled row of labelled tools with their key, and a one-line hint for the hovered
// (or armed) one.

import React, { useState } from 'react';
import { classNames } from '@ui/classNames';
import { type IconName, Icon } from '@ui/components/Icon';

export interface DockTrayItem {
  id: string;
  label: string;
  icon: IconName;
  hint: string;
  shortcut?: string | undefined;
  active?: boolean;
  onPick: () => void;
}

interface DockTrayProps {
  id: string;
  label: string;
  items: readonly DockTrayItem[];
}

export function DockTray({ id, label, items }: DockTrayProps): React.ReactElement {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const described = items.find((item) => item.id === focusedId) ?? items.find((item) => item.active === true);
  return (
    <div className="dock-tray" id={id} role="group" aria-label={label}>
      <span className="dock-tray__title" aria-hidden="true">
        {label}
      </span>
      <div className="dock-tray__items">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={classNames('dock-tray__item', item.active === true && 'dock-tray__item--active')}
            aria-pressed={item.active}
            title={item.shortcut === undefined ? item.hint : `${item.hint} (${item.shortcut})`}
            onClick={item.onPick}
            onPointerEnter={() => setFocusedId(item.id)}
            onFocus={() => setFocusedId(item.id)}
          >
            <Icon name={item.icon} size={22} />
            <span className="dock-tray__label">
              {item.label}
              {item.shortcut !== undefined && (
                <kbd className="dock-tray__key" aria-hidden="true">
                  {item.shortcut}
                </kbd>
              )}
            </span>
          </button>
        ))}
      </div>
      {described !== undefined && (
        <p className="dock-tray__hint">
          <b>{described.label}</b> — {described.hint}
        </p>
      )}
    </div>
  );
}
