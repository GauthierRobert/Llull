/** Access to `doc.plant.pid` (plant 04 PID). */

import type { CadDocument } from '@core/model/types';
import type { PidModel } from './model';

export const DEFAULT_LINE_NUMBER_FORMAT = '{dn}-{fluid}-{seq}-{class}';

export const EMPTY_PID: PidModel = {
  version: 1,
  convention: 'ISA-5.1',
  lineNumberFormat: DEFAULT_LINE_NUMBER_FORMAT,
  tagFormats: {},
  sheets: {},
  sheetOrder: [],
  items: {},
  itemOrder: [],
  counters: {},
};

export const getPid = (doc: Pick<CadDocument, 'plant'>): PidModel => doc.plant?.pid ?? EMPTY_PID;

export const withPid = (doc: CadDocument, pid: PidModel): CadDocument => ({ ...doc, plant: { ...doc.plant, pid } });
