import { commandCatalog } from '@core/commands/schema';
import { addPidActuatingSystem } from './commands/addPidActuatingSystem';
import { addPidEquipment } from './commands/addPidEquipment';
import { addPidInline } from './commands/addPidInline';
import { addPidInstrument } from './commands/addPidInstrument';
import { addPidLine } from './commands/addPidLine';
import { addPidNozzle } from './commands/addPidNozzle';
import { addPidOffPageConnector } from './commands/addPidOffPageConnector';
import { addPidSignalLine } from './commands/addPidSignalLine';
import { checkPid } from './commands/checkPid';
import { createPidSheet } from './commands/createPidSheet';
import { deletePidItem } from './commands/deletePidItem';
import { importDexpi } from './commands/importDexpi';
import { parseInstrumentTag } from './commands/parseInstrumentTag';
import { pidReport } from './commands/pidReport';
import { renumberPidLines } from './commands/renumberPidLines';
import { reversePidFlow } from './commands/reversePidFlow';
import { setPidConventions } from './commands/setPidConventions';
import { updatePidItem } from './commands/updatePidItem';

/** M4: tag parser (ISA 5.1), check_pid (16 rules) and the five lists in pid_report. M2: DEXPI 1.3 import and the census / connectivity report; M3: authoring (sheets, equipment, lines, inline split / heal, instruments, signals, actuating systems, OPC, flow). TECHNICAL_SPEC §10. */
export const pidCatalog = commandCatalog(
  importDexpi,
  pidReport,
  checkPid,
  parseInstrumentTag,
  createPidSheet,
  addPidEquipment,
  addPidNozzle,
  addPidLine,
  addPidInline,
  addPidInstrument,
  addPidSignalLine,
  addPidActuatingSystem,
  addPidOffPageConnector,
  updatePidItem,
  deletePidItem,
  reversePidFlow,
  renumberPidLines,
  setPidConventions,
);
