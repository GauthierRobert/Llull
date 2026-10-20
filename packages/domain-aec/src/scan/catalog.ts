/** Commands of the scan plugin (plant 10 SCN), toolset `scan`. */

import { commandCatalog } from '@core/commands/schema';
import { clearScanCrop, setScanCrop } from './cropCommands';
import { describePointCloud, measureCloud, nearestCloudPoint, queryCloudPoints } from './queryCommands';
import { attachPointCloud, detachPointCloud, updatePointCloud } from './referenceCommands';
import { acceptRegistration, applyRegistration, markRegistrationSupplied } from './registrationCommands';
import { computeRegistration } from './registrationQuery';
import { extractPipes, fitPrimitive } from './fitCommands';
import { sliceCloud } from './sliceCommand';
import { acceptAsbuiltExtraction, commitAsbuiltExtraction } from './extractionCommands';
import { checkAsbuiltClash, cloudToModelDeviation } from './compareCommands';
import { checkPointClouds } from './checkCommand';

export const scanCommands = commandCatalog(
  attachPointCloud,
  updatePointCloud,
  detachPointCloud,
  setScanCrop,
  clearScanCrop,
  describePointCloud,
  queryCloudPoints,
  nearestCloudPoint,
  measureCloud,
  computeRegistration,
  applyRegistration,
  markRegistrationSupplied,
  acceptRegistration,
  sliceCloud,
  fitPrimitive,
  extractPipes,
  commitAsbuiltExtraction,
  acceptAsbuiltExtraction,
  cloudToModelDeviation,
  checkAsbuiltClash,
  checkPointClouds,
);
