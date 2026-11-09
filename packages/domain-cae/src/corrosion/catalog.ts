/** The PHY-13 corrosion commands (plugin `physics-corrosion`, toolset `materials`). */

import { commandCatalog } from '@core/commands/schema';
import { acceptCorrosionItem } from './acceptCommand';
import { checkMaterialCompatibility } from './checkCommand';
import { listSurfaceSystems } from './listSurfaceSystems';
import { assignSurfaceSystem, declareIsolation, removeIsolation } from './protectionCommands';
import { listCompatibilityRules } from './rulesCommand';
import { setGalvanicGroup, setServiceEnvironment } from './settingsCommands';

export const corrosionCommands = commandCatalog(
  setServiceEnvironment,
  setGalvanicGroup,
  assignSurfaceSystem,
  listSurfaceSystems,
  declareIsolation,
  removeIsolation,
  listCompatibilityRules,
  checkMaterialCompatibility,
  acceptCorrosionItem,
);
