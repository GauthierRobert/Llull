/** PHY-14 space-environment commands: mission environment, outgassing screening, moisture uptake, hygroscopic strain, atomic-oxygen erosion. */

import { commandCatalog } from '@core/commands/schema';
import { approveEnvironmentDeviation } from './acceptCommand';
import { aoErosion } from './aoCommand';
import { checkSpaceEnvironment } from './checkCommand';
import { hygroStrain } from './hygroCommand';
import { setMissionEnvironment } from './setCommand';
import { moistureUptake } from './uptakeCommand';

export const environmentCommands = commandCatalog(
  setMissionEnvironment,
  checkSpaceEnvironment,
  moistureUptake,
  hygroStrain,
  aoErosion,
  approveEnvironmentDeviation,
);
