/** Reads the 01 PSC validation pack so the tests and the pack cannot drift (TECHNICAL_SPEC §9). */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(__dirname, '../../../../docs/plant/01-piping-specs-catalog/validation/data');

export const packJson = <T = Record<string, unknown>>(file: string): T => JSON.parse(readFileSync(path.join(DATA, file), 'utf8')) as T;

export interface PipePackRow {
  nps: number;
  schedule: string;
  standard: string;
  odMm: number;
  wallMm: number;
  grade: string;
}
