/** Physics verification & validation (PHY-00): convergence studies and the benchmark judge. */

import { commandCatalog } from '@core/commands/schema';
import { checkConvergence } from './checkConvergence';
import { checkVerification } from './checkVerification';
import { compareToExpected } from './compareToExpected';
import { recordConvergenceStudy } from './recordConvergenceStudy';
import { acceptVerificationException, deleteConvergenceStudy } from './studyCommands';

export const vnvCommands = commandCatalog(
  checkConvergence,
  compareToExpected,
  recordConvergenceStudy,
  deleteConvergenceStudy,
  checkVerification,
  acceptVerificationException,
);
