/** Retired aero command names: old name -> rewrite onto the replacement, applied to saved feature-history and recipe steps on load. */

import type { RetiredCommandRewrite } from '@core/commands/types';

export const renameTo =
  (name: string): RetiredCommandRewrite =>
  (params) => ({ name, params });
