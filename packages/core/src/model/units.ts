/** Document unit conversions (the unit list itself is `DOCUMENT_UNITS` in ./types). */

import type { DocumentUnit } from './types';

/** Millimetres in one document unit. */
export const MM_PER_UNIT: Readonly<Record<DocumentUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};
