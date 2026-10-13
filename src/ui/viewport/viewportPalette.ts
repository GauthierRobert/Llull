/**
 * @layer ui/viewport
 *
 * Theme-aware canvas palette for the 2D and 3D viewports. three.js needs concrete
 * colors (CSS variables do not reach WebGL), so each theme maps to hex values that
 * match the design tokens in styles/tokens.css.
 */

import { type Theme, useThemeStore } from '@ui/store';
import type { SnapType } from './2d/snapping/types';
import type { Snap3DType } from './3d/snap3d';

/** Tint of a selected 2D shape or text entity. */
export const SELECTION_COLOR = '#5b8dee';

/** Emissive tint + strength of a selected 3D solid (single mesh and instanced batches). */
export const SELECTION_EMISSIVE = '#3a7bd5';
export const SELECTION_EMISSIVE_INTENSITY = 0.35;

/** X-ray display mode: emissive tint, emissive strength and surface opacity per selection state. */
export const XRAY_EMISSIVE = '#4a9eff';
export const XRAY_EMISSIVE_INTENSITY = { idle: 0.2, selected: 0.6 } as const;
export const XRAY_OPACITY = { idle: 0.18, selected: 0.35 } as const;

/** Accent of measurement / box-select / draw-preview overlays. */
export const OVERLAY_ACCENT = '#60a5fa';

/** Snap-marker colour per snap type (2D drafting). */
export const SNAP_COLORS_2D: Record<SnapType, string> = {
  endpoint: '#e040fb', // magenta
  midpoint: '#00e5ff', // cyan
  center: '#ffee58', // yellow
  intersection: '#ff9800', // orange
  perpendicular: '#69f0ae', // green
  tangent: '#b9f6ca', // lime
  extension: '#26c6da', // teal
  nearest: '#40c4ff', // blue
  grid: '#546e7a', // muted blue-grey
};

/** Snap-marker colour per snap type (3D). */
export const SNAP_COLORS_3D: Record<Snap3DType, string> = {
  vertex: '#f5c842',
  edge: '#42d4f5',
  'face-center': '#42f5a7',
  grid: '#8090a0',
  none: '#ffffff',
};

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
