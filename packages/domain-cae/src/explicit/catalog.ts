/** PHY-19 explicit dynamics (RS1 RS-8): set-up, validated result recording and the read-only queries (plugin `explicit`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { explicitEnergyCheck } from './queries';

import { addContact } from './contactCommands';
import { setJohnsonCookFailure } from './failureCommand';
import { setAdiabaticHeating } from './heatingCommand';
import { addImposedMotion } from './imposedMotionCommands';
import { setExplicitShell } from './shellCommand';
import { recordExplicitResults } from './record';
import { addRigidWall, setExplicitControls, setInitialVelocity } from './setupCommands';

export const explicitCommands = commandCatalog(
  setExplicitControls,
  setInitialVelocity,
  addRigidWall,
  setJohnsonCookFailure,
  setAdiabaticHeating,
  addImposedMotion,
  addContact,
  setExplicitShell,
  recordExplicitResults,
  explicitEnergyCheck,
);
