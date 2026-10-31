import { commandCatalog } from '@core/commands/schema';
import { importDexpi } from './commands/importDexpi';
import { pidReport } from './commands/pidReport';

/** M2: DEXPI 1.3 import and the census / connectivity report (TECHNICAL_SPEC §10); M3 adds the authoring commands. */
export const pidCatalog = commandCatalog(importDexpi, pidReport);
