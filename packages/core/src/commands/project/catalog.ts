/** build_project plans and parametric templates. */

import { commandCatalog } from '../schema';
import { buildProject } from './buildProject';
import { instantiateTemplate } from './templates';

export const projectCommands = commandCatalog(buildProject, instantiateTemplate);
