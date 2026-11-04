/**
 * Scan plugin (plant 10 SCN, RS-3 / RS-4): point-cloud references, crops, registrations, extractions and the read-only scan queries. Points
 * never enter the document; heavy numerics run in the native `llull-cloud` behind `ExecutionContext.pointClouds`.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { scanCommands } from './catalog';
import { scanDocument } from './document';
import { cloudOverlay } from './cloudOverlay';

export const scanPlugin: CadPlugin = {
  name: 'scan',
  toolset: 'scan',
  commands: scanCommands,
  document: scanDocument,
  renderOverlays: [cloudOverlay],
};
