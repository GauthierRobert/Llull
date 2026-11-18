// One titled section of a tool flyout: labelled tools with their shortcut key. The flyout shows the hint of the hovered tool.

import React from 'react';
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
  label: string;
  items: readonly DockTrayItem[];
  /** The tool under the pointer / keyboard focus. */
  onDescribe: (item: DockTrayItem) => void;
}

export function DockTray({ label, items, onDescribe }: DockTrayProps): React.ReactElement {
  return (
    <div className="dock-tray" role="group" aria-label={label}>
      <span className="dock-tray__title" aria-hidden="true">
        {label}
      </span>
      <div className="dock-tray__items">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={classNames('dock-tray__item', item.active === true && 'dock-tray__item--active')}
            aria-label={item.label}
            aria-pressed={item.active}
            onClick={item.onPick}
            onPointerEnter={() => onDescribe(item)}
            onFocus={() => onDescribe(item)}
          >
            <Icon name={item.icon} size={22} />
            <span className="dock-tray__label">{item.label}</span>
            {item.shortcut !== undefined && (
              <kbd className="dock-tray__key" aria-hidden="true">
                {item.shortcut}
              </kbd>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
