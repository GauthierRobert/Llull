/**
 * @layer ui/components
 *
 * ThemeToggle — icon button flipping the dark / light color theme.
 * Reads/writes useThemeStore only (presentation state).
 */

import React from 'react';
import { useThemeStore } from '@ui/store';
import { IconButton } from '@ui/panels/PanelParts';

export function ThemeToggle(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;

  return (
    <IconButton
      icon={theme === 'dark' ? 'sun' : 'moon'}
      size={16}
      label={label}
      onClick={toggleTheme}
    />
  );
}
