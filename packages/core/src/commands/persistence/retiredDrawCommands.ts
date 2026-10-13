/**
 * Retired draw / solid / inspect / document commands, each a special case of a general command.
 * Same-parameter merges are plain renames; `draw_line` becomes the open 2-point `draw_polyline`.
 */

import type { RetiredCommandRewrite } from '../types';

const renameTo =
  (name: string): RetiredCommandRewrite =>
  (params) => ({ name, params });

export const RETIRED_DRAW_COMMANDS: Readonly<Record<string, RetiredCommandRewrite>> = {
  draw_line: ({ start, end, ...rest }) => ({
    name: 'draw_polyline',
    params: { ...rest, points: [start, end] },
  }),
  draw_circle: renameTo('draw_arc'),
  extrude_sketch: renameTo('extrude_profile'),
  measure_volume: renameTo('mass_properties'),
  look_at: renameTo('set_camera'),
  rename_layer: renameTo('update_layer'),
  set_layer_visibility: renameTo('update_layer'),
  set_layer_lock: renameTo('update_layer'),
};
