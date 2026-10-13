// Theme → concrete canvas colors (CSS variables do not reach WebGL), matching styles/tokens.css.

import { type Theme, useThemeStore } from '@ui/store';
import type { SnapType } from './2d/snapping/types';
import type { Snap3DType } from './3d/snap3d';

/** Selected 2D shape / text. */
export const SELECTION_COLOR = '#5b8dee';

/** Selected 3D solid (mesh and instanced). */
export const SELECTION_EMISSIVE = '#3a7bd5';
export const SELECTION_EMISSIVE_INTENSITY = 0.35;

/** X-ray display: emissive tint, strength and opacity per selection state. */
export const XRAY_EMISSIVE = '#4a9eff';
export const XRAY_EMISSIVE_INTENSITY = { idle: 0.2, selected: 0.6 } as const;
export const XRAY_OPACITY = { idle: 0.18, selected: 0.35 } as const;

/** Measurement / box-select / draw-preview overlays. */
export const OVERLAY_ACCENT = '#60a5fa';

export const SNAP_COLORS_2D: Record<SnapType, string> = {
  endpoint: '#e040fb',
  midpoint: '#00e5ff',
  center: '#ffee58',
  intersection: '#ff9800',
  perpendicular: '#69f0ae',
  tangent: '#b9f6ca',
  extension: '#26c6da',
  nearest: '#40c4ff',
  grid: '#546e7a',
};

export const SNAP_COLORS_3D: Record<Snap3DType, string> = {
  vertex: '#f5c842',
  edge: '#42d4f5',
  'face-center': '#42f5a7',
  grid: '#8090a0',
  none: '#ffffff',
};

interface ViewportPalette {
  background: string;
  gridCell: string;
  gridSection: string;
  grid2dMinor: number;
  grid2dMajor: number;
  /** Color stays constant: drei rebuilds targets on a color change. */
  contactShadowOpacity: number;
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

export function useViewportPalette(): ViewportPalette {
  const theme = useThemeStore((s) => s.theme);
  return PALETTES[theme];
}
