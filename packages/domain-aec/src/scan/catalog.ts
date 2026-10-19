/** Commands of the scan plugin (plant 10 SCN), toolset `scan`. */

import { commandCatalog } from '@core/commands/schema';
import { clearScanCrop, setScanCrop } from './cropCommands';
import { describePointCloud, measureCloud, nearestCloudPoint, queryCloudPoints } from './queryCommands';
import { attachPointCloud, detachPointCloud, updatePointCloud } from './referenceCommands';

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
);
