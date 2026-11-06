/** Readout values and their labels (TR-MOV-09): the same numbers go to `data.timeline[k].readouts` and to the picture. */

import type { ReadoutValue } from './types';
import { significantNumber } from '../../../lib/compactNumber';

export const RAD_TO_DEG = 180 / Math.PI;

/** `name = value unit`, the value in 5 significant digits. */
export const readoutLabel = (id: string, readout: ReadoutValue): string =>
  `${id} = ${significantNumber(readout.value, 5)}${readout.unit === '' ? '' : ` ${readout.unit}`}`;

/** Linear blend of two series values: the first one exactly at weight 0. */
export const blend = (a: number, b: number, weight: number): number => (weight === 0 ? a : a + (b - a) * weight);

export const XYZ = ['x', 'y', 'z'] as const;
