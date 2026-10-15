// Dark / light theme toggle (useThemeStore), as a labelled menu item.

import React from 'react';
import { useThemeStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';

export function ThemeToggle(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;

  return (
    <button type="button" className="menu-item" aria-label={label} title={label} onClick={toggleTheme}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
      {next === 'light' ? 'Light theme' : 'Dark theme'}
    </button>
  );
}
