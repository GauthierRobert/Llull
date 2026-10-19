/** PHY-19 explicit dynamics (RS1 RS-8): set-up, validated result recording and the read-only queries (plugin `explicit`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { explicitEnergyCheck, explicitReport } from './queries';
import { explicitQuickCheck } from './quickCheck';
import { recordExplicitResults } from './record';
import { addRigidWall, deleteRigidWall, setExplicitControls, setInitialVelocity } from './setupCommands';

export const explicitCommands = commandCatalog(
  setExplicitControls,
  setInitialVelocity,
  addRigidWall,
  deleteRigidWall,
  recordExplicitResults,
  explicitReport,
  explicitEnergyCheck,
  explicitQuickCheck,
);
