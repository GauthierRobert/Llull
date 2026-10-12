/**
 * Building / industrial commands folded into a more general one: old name -> rewrite onto the
 * replacement, applied to saved feature-history and recipe steps on load.
 * @layer domain-aec
 */

import type { RetiredCommandRewrite } from '@core/commands/types';

export const aecRetiredCommands: Readonly<Record<string, RetiredCommandRewrite>> = {
  add_wall: ({ start, end, ...options }) => ({
    name: 'draw_walls',
    params: { ...options, points: [start, end] },
  }),
};
