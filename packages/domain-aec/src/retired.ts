/**
 * Building / industrial / civil commands folded into a more general one or renamed: old name -> rewrite onto the replacement, applied to
 * saved feature-history and recipe steps on load.
 */

import type { RetiredCommandRewrite } from '@core/commands/types';

const renamed =
  (name: string): RetiredCommandRewrite =>
  (params) => ({ name, params });

export const aecRetiredCommands: Readonly<Record<string, RetiredCommandRewrite>> = {
  add_wall: ({ start, end, ...options }) => ({ name: 'draw_walls', params: { ...options, points: [start, end] } }),
  add_pipe: renamed('add_drainage_pipe'),
  update_pipe: renamed('update_drainage_pipe'),
  export_dxf: renamed('export_building_dxf'),
  export_long_section: renamed('export_road_long_section'),
};
