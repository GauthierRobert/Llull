// One button over the 3D viewport that reveals the view options (display mode, section, quality, presets) on demand.

import React from 'react';
import { classNames } from '@ui/classNames';
import { useChromeStore } from '@ui/store/chromeStore';
import { Icon } from '@ui/components/Icon';

export function ViewOptionsToggle(): React.ReactElement {
  const open = useChromeStore((s) => s.viewOptionsOpen);
  const toggle = useChromeStore((s) => s.toggleViewOptions);
  const label = open ? 'Hide view options' : 'Show view options';
  return (
    <button
      type="button"
      className={classNames('view-options-toggle', open && 'view-options-toggle--open')}
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={toggle}
    >
      <Icon name="eye" size={16} />
    </button>
  );
}
