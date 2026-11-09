/** PHY-18 probabilistic analysis: random variables, limit states, FORM / SORM, Monte Carlo and FOSM. */

import { commandCatalog } from '@core/commands/schema';
import { defineLimitState, defineRandomVariable, deleteRandomVariable, setCorrelation } from './setupCommands';
import { acceptReliabilityResult } from './acceptance';
import { basisToleranceFactor } from './basisCommands';
import { checkProbabilistic, describeProbabilisticModel } from './inspectCommands';
import { defineResponse } from './responseCommands';
import { parameterSensitivity, sensitivityIndices } from './sensitivityCommands';
import { propagateUncertainty, runReliabilityStudy } from './studyCommands';

export const reliabilityCommands = commandCatalog(
  defineRandomVariable,
  deleteRandomVariable,
  setCorrelation,
  defineLimitState,
  propagateUncertainty,
  runReliabilityStudy,
  defineResponse,
  parameterSensitivity,
  sensitivityIndices,
  describeProbabilisticModel,
  basisToleranceFactor,
  checkProbabilistic,
  acceptReliabilityResult,
);
