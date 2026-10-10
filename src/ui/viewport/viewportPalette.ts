/**
 * @layer ui/viewport
 *
 * Theme-aware canvas palette for the 2D and 3D viewports. three.js needs concrete
 * colors (CSS variables do not reach WebGL), so each theme maps to hex values that
 * match the design tokens in styles/tokens.css.
 */

import { type Theme, useThemeStore } from '@ui/store';

/** Tint of a selected 2D shape or text entity. */
export const SELECTION_COLOR = '#5b8dee';

interface ViewportPalette {
  /** WebGL clear color behind the scene. */
  background: string;
  /** 3D ground grid — fine cells / major sections. */
  gridCell: string;
  gridSection: string;
  /** 2D drafting grid — minor / major lines. */
  grid2dMinor: number;
  grid2dMajor: number;
  /** Contact-shadow strength under solids (color stays constant: drei rebuilds targets on color change). */
  contactShadowOpacity: number;
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
    contactShadowOpacity: 0.55,
    axisColors: ['#e5534b', '#57ab5a', '#4c8dff'],
    axisLabel: '#f2f3f5',
  },
  light: {
    background: '#eceef1',
    gridCell: '#d3d7de',
    gridSection: '#b9bfc9',
    grid2dMinor: 0xdcdfe5,
    grid2dMajor: 0xc4c9d2,
    contactShadowOpacity: 0.3,
    axisColors: ['#d1453b', '#3f9142', '#2f6fe4'],
    axisLabel: '#ffffff',
  },
};

/** Narrow subscription to the theme; returns the matching canvas palette. */
export function useViewportPalette(): ViewportPalette {
  const theme = useThemeStore((s) => s.theme);
  return PALETTES[theme];
}
