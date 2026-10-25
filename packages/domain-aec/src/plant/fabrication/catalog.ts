import { commandCatalog } from '@core/commands/schema';
import { deletePcfLine } from './commands/deletePcfLine';
import { exportPcf } from './commands/exportPcf';
import { importPcf } from './commands/importPcf';

export const fabricationCatalog = commandCatalog(importPcf, exportPcf, deletePcfLine);
