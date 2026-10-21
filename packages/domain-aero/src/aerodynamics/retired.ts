/** Retired aerodynamics commands: `draw_naca_airfoil` is `airfoil_from_naca` as a plain polyline; `aero_drag` was renamed. */

import type { RetiredCommandRewrite } from '@core/commands/types';
import { renameTo } from '../shared/retired';

const DEFAULT_POINTS_PER_SIDE = 60;

export const aerodynamicsRetiredCommands: Readonly<Record<string, RetiredCommandRewrite>> = {
  draw_naca_airfoil: ({ naca, chord, pointsPerSide, closedTrailingEdge, incidenceDeg, position }) => ({
    name: 'airfoil_from_naca',
    params: {
      designation: naca,
      chord,
      points: 2 * (typeof pointsPerSide === 'number' ? pointsPerSide : DEFAULT_POINTS_PER_SIDE) + 1,
      trailingEdge: closedTrailingEdge === false ? 'open' : 'closed',
      as: 'polyline',
      ...(incidenceDeg !== undefined && { incidenceDeg }),
      ...(position !== undefined && { position }),
    },
  }),
  aero_drag: renameTo('compute_aero_drag'),
};
