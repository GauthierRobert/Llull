// Presentation of the rigid-body loads (computed by `@core/dynamics/dynamicsLoads`): layer labels and glyph / swatch colours.

import type { LoadLayer } from '@core/dynamics/dynamicsLoads';

export const LOAD_LAYER_LABELS: Readonly<Record<LoadLayer, string>> = {
  gravity: 'Weight',
  joints: 'Joints & gears',
  drives: 'Motor torque',
  thrust: 'Thrust',
  reactions: 'Joint reactions',
};

/** Glyph / swatch colour per layer (viewport overlay and review list). */
export const LOAD_COLORS: Readonly<Record<LoadLayer, string>> = {
  gravity: '#ff9100',
  joints: '#00b8d4',
  drives: '#64dd17',
  thrust: '#ff4081',
  reactions: '#cc79a7',
};
