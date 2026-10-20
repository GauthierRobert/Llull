/** GD&T / PMI queries (aerospace 03 GDT, milestone M5): tolerance stack-up and fastener fit. */

import { commandCatalog } from '../schema';
import { fastenerTolerance } from './fastener';
import { analyzeStackup } from './stackup';

export const pmiCommands = commandCatalog(analyzeStackup, fastenerTolerance);
