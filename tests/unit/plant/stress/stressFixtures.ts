/** 07 PST fixtures: the validation pack's reference data read straight from `docs/plant/07-pipe-stress-flexibility/validation/data`. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

const DATA = path.resolve(__dirname, '../../../../docs/plant/07-pipe-stress-flexibility/validation/data');

export const referenceData = <T>(file: string): T => JSON.parse(readFileSync(path.join(DATA, file), 'utf8')) as T;

export const MM_PER_IN = 25.4;

/** Relative error check with the quantity named in the failure. */
export const expectRel = (actual: number, expected: number, rel: number, label = ''): void => {
  expect(Math.abs(actual - expected) / Math.abs(expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(rel);
};
