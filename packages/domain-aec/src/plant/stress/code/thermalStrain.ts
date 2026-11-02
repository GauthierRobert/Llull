/**
 * Thermal strain of the bundled carbon steel table between two temperatures (degC in, strain out): linear interpolation of the strain
 * from the 70 degF reference between table rows; a temperature within `EDGE_TOLERANCE_K` of a row snaps to it; no extrapolation.
 */

import { CARBON_STEEL_ROWS, REFERENCE_F } from '../data/carbonSteelC1';

/** 21.1 degC and 204.4 degC are how 70 and 400 degF are written in SI; a quarter kelvin keeps them on their rows. */
const EDGE_TOLERANCE_K = 0.25;

const toF = (celsius: number): number => (celsius * 9) / 5 + 32;
const toC = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;

interface Node {
  readonly tempF: number;
  readonly strain: number;
  readonly grade: 'A' | 'B';
}

const NODES: readonly Node[] = [
  { tempF: REFERENCE_F, strain: 0, grade: 'A' },
  ...CARBON_STEEL_ROWS.map(([tempF, alpha, , grade]) => ({ tempF, strain: alpha * (tempF - REFERENCE_F), grade })),
];

const first = NODES[0] as Node;
const last = NODES[NODES.length - 1] as Node;

export const TABLE_RANGE_C = { minC: toC(first.tempF), maxC: toC(last.tempF) } as const;

export interface StrainPoint {
  readonly strain: number;
  readonly grade: 'A' | 'B';
  readonly snapped: boolean;
}

/** Strain at `celsius`, or null outside the table range. A temperature within the tolerance of a node takes the node (and its grade). */
export function carbonSteelStrain(celsius: number): StrainPoint | null {
  const fahrenheit = toF(celsius);
  const slack = EDGE_TOLERANCE_K * 1.8;
  const node = NODES.find((candidate) => Math.abs(candidate.tempF - fahrenheit) <= slack);
  if (node !== undefined) return { strain: node.strain, grade: node.grade, snapped: Math.abs(node.tempF - fahrenheit) > 1e-9 };
  if (fahrenheit < first.tempF || fahrenheit > last.tempF) return null;
  const upperIndex = NODES.findIndex((candidate) => candidate.tempF >= fahrenheit);
  const upper = NODES[upperIndex] as Node;
  const lower = NODES[upperIndex - 1] as Node;
  const share = (fahrenheit - lower.tempF) / (upper.tempF - lower.tempF);
  return { strain: lower.strain + share * (upper.strain - lower.strain), grade: 'B', snapped: false };
}
