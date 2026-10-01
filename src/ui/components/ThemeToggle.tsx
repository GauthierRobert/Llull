/**
 * @layer ui/components
 *
 * ThemeToggle — icon button flipping the dark / light color theme.
 * Reads/writes useThemeStore only (presentation state).
 */

import React from 'react';
import { useThemeStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';

export function ThemeToggle(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
    </button>
  );
}
