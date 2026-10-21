/** Retired flow commands: renamed verb-first (`cfd_create_case` -> `create_cfd_case`, ...). */

import type { RetiredCommandRewrite } from '@core/commands/types';
import { renameTo } from '../shared/retired';

export const cfdRetiredCommands: Readonly<Record<string, RetiredCommandRewrite>> = {
  cfd_create_case: renameTo('create_cfd_case'),
  cfd_update_case: renameTo('update_cfd_case'),
  cfd_delete_case: renameTo('delete_cfd_case'),
  cfd_set_boundary: renameTo('set_cfd_boundary'),
  cfd_prepare: renameTo('prepare_cfd_case'),
};
