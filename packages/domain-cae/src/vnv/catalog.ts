/** Physics verification & validation (PHY-00): convergence studies and the benchmark judge. */

import { commandCatalog } from '@core/commands/schema';
import { checkConvergence } from './checkConvergence';
import { compareToExpected } from './compareToExpected';

export const vnvCommands = commandCatalog(checkConvergence, compareToExpected);
