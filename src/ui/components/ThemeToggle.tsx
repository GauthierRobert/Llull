// Dark / light theme toggle (useThemeStore).

import React from 'react';
import { useThemeStore } from '@ui/store';
import { IconButton } from '@ui/panels/PanelParts';

export function ThemeToggle(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;

  return <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} size={16} label={label} onClick={toggleTheme} />;
}
