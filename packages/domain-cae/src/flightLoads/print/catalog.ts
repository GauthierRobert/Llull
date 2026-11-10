/** 14 FLL-M3 printed-part commands. */

import { commandCatalog } from '@core/commands/schema';
import { fitPrintInfillExponent, recordPrintCoupon } from './couponCommands';
import { setPrintIdealization } from './setPrintIdealization';

export const printCommands = commandCatalog(fitPrintInfillExponent, recordPrintCoupon, setPrintIdealization);
