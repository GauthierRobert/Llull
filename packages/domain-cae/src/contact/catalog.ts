/** The PHY-06 contact and joint commands (plugin `cae`, toolset `analysis`). */

import { commandCatalog } from '@core/commands/schema';
import { boltedJointCheck } from './boltedJointCommand';
import { hertzContact } from './hertzCommand';
import { interferenceFit } from './interferenceCommand';
import { addContactPair, deleteContactPair, updateContactPair } from './pairCommands';
import { checkContact, contactReport } from './queries';

export const contactCommands = commandCatalog(
  hertzContact,
  interferenceFit,
  boltedJointCheck,
  addContactPair,
  updateContactPair,
  deleteContactPair,
  contactReport,
  checkContact,
);
