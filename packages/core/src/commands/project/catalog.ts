/** build_project plans. */

import { commandCatalog } from '../schema';
import { buildProject } from './buildProject';

export const projectCommands = commandCatalog(buildProject);
