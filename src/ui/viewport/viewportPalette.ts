/**
 * @layer ui/viewport
 *
 * Theme-aware canvas palette for the 2D and 3D viewports. three.js needs concrete
 * colors (CSS variables do not reach WebGL), so each theme maps to hex values that
 * match the design tokens in styles/tokens.css.
 */

import { useThemeStore } from '@ui/store';
import type { Theme } from '@ui/store';

export interface ViewportPalette {
  /** WebGL clear color behind the scene. */
  background: string;
  /** 3D ground grid — fine cells / major sections. */
  gridCell: string;
  gridSection: string;
  /** 2D drafting grid — minor / major lines. */
  grid2dMinor: number;
  grid2dMajor: number;
  /** Contact-shadow tint under solids. */
  contactShadow: string;
  /** Orientation gizmo axis colors (X, Y, Z) + label color. */
  axisColors: [string, string, string];
  axisLabel: string;
}

const PALETTES: Record<Theme, ViewportPalette> = {
  dark: {
    background: '#1b1d22',
    gridCell: '#2b2f38',
    gridSection: '#3b404c',
    grid2dMinor: 0x25282f,
    grid2dMajor: 0x343843,
    contactShadow: '#000000',
    axisColors: ['#e5534b', '#57ab5a', '#4c8dff'],
    axisLabel: '#f2f3f5',
  },
  light: {
    background: '#eceef1',
    gridCell: '#d3d7de',
    gridSection: '#b9bfc9',
    grid2dMinor: 0xdcdfe5,
    grid2dMajor: 0xc4c9d2,
    contactShadow: '#3a4252',
    axisColors: ['#d1453b', '#3f9142', '#2f6fe4'],
    axisLabel: '#ffffff',
  },
};

export function viewportPaletteFor(theme: Theme): ViewportPalette {
  return PALETTES[theme];
}

/** Narrow subscription to the theme; returns the matching canvas palette. */
export function useViewportPalette(): ViewportPalette {
  const theme = useThemeStore((s) => s.theme);
  return PALETTES[theme];
}
