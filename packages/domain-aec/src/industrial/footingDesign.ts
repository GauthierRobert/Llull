/**
 * RC pad footing design (EN 1992-1-1, C25/30, B500): bottom mat from bending at the column / base
 * plate face, one-way shear at d, punching at every perimeter within 2d; reinforcement is stored on the footing.
 * @layer domain-aec
 */

export type { PadSize, FootingDesignRow, Geometry, Load } from './footingModel';
export { designMat } from './footingSizing';
export type { Attempt } from './footingSizing';
export { designFootings } from './footingDesignCommand';
export type { FootingDesignParams } from './footingDesignCommand';
