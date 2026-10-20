/** PHY-19 explicit dynamics (RS1 RS-8): set-up, validated result recording and the read-only queries (plugin `explicit`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { explicitEnergyCheck, explicitReport } from './queries';
import { explicitQuickCheck } from './quickCheck';
import { addContact, deleteContact } from './contactCommands';
import { setJohnsonCookFailure } from './failureCommand';
import { setAdiabaticHeating } from './heatingCommand';
import { setExplicitShell } from './shellCommand';
import { recordExplicitResults } from './record';
import { addRigidWall, deleteRigidWall, setExplicitControls, setInitialVelocity } from './setupCommands';

export const explicitCommands = commandCatalog(
  setExplicitControls,
  setInitialVelocity,
  addRigidWall,
  deleteRigidWall,
  setJohnsonCookFailure,
  setAdiabaticHeating,
  addContact,
  deleteContact,
  setExplicitShell,
  recordExplicitResults,
  explicitReport,
  explicitEnergyCheck,
  explicitQuickCheck,
);
