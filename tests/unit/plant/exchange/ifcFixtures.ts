/** Fixtures of the 08 DAT IFC tests: the SC-DAT-01 scene (tank, pump, two lines) and the pack reference files. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PACK, scDat01Document } from '../data/dataFixtures';

/** The SC-DAT-01 document: every plan step before its export_ifc step. */
export const scDat01 = scDat01Document;

export const stamp = '2026-10-18T00:00:00';

export const referenceIfc = (name: string): string => readFileSync(path.join(PACK, 'data', 'reference', name), 'utf8');
