/** The PHY-06 contact and joint commands (plugin `cae`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { boltedJointCheck } from './boltedJointCommand';
import { hertzContact } from './hertzCommand';
import { jointFromFastenerStack } from './jointFromStack';
import { jointMargins } from './jointMargins';
import { jointStiffnessFromFe } from './jointStiffnessCommand';
import { pinBearingReport, pinInHole } from './pinInHole';
import { interferenceFit } from './interferenceCommand';
import { addContactPair, deleteContactPair, updateContactPair } from './pairCommands';
import { addBoltPretension, deleteBoltPretension } from './pretensionCommands';
import { checkContact, contactReport } from './queries';

export const contactCommands = commandCatalog(
  hertzContact,
  interferenceFit,
  boltedJointCheck,
  addContactPair,
  updateContactPair,
  deleteContactPair,
  addBoltPretension,
  deleteBoltPretension,
  jointFromFastenerStack,
  jointStiffnessFromFe,
  jointMargins,
  pinInHole,
  pinBearingReport,
  contactReport,
  checkContact,
);
