/** Class library of the authoring commands (M3: the DEXPI classes llull maps; the symbol library of M5 draws them) and the default sheet size of a symbol. */

import { KNOWN_EQUIPMENT_CLASSES, KNOWN_PIPING_CLASSES } from '../dexpi/proteusClasses';
import { fail, type Fail } from './refs';

/** Half extents [x, y] of an equipment symbol, mm; nozzle ports sit on this box. */
const HALF_EXTENTS: Readonly<Record<string, readonly [number, number]>> = {
  Tank: [25, 25],
  PressureVessel: [15, 30],
  ProcessColumn: [12, 40],
  ColumnSection: [12, 20],
  CentrifugalPump: [20, 15],
  ReciprocatingPump: [20, 15],
  RotaryPump: [20, 15],
  PlateHeatExchanger: [30, 12],
  TubularHeatExchanger: [30, 12],
};
export const DEFAULT_HALF_EXTENTS: readonly [number, number] = [20, 20];
export const halfExtents = (dexpiClass: string): readonly [number, number] => HALF_EXTENTS[dexpiClass] ?? DEFAULT_HALF_EXTENTS;

/** Edit distance, capped: enough to rank a handful of class names. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] ?? 0;
}

/** Up to five known names closest to `name` (case-insensitive substring first, then edit distance). */
export function closeNames(known: ReadonlySet<string>, name: string): string[] {
  const wanted = name.toLowerCase();
  return [...known]
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const score = lower.includes(wanted) || wanted.includes(lower) ? 0 : editDistance(lower, wanted);
      return { candidate, score };
    })
    .sort((x, y) => x.score - y.score || (x.candidate < y.candidate ? -1 : 1))
    .slice(0, 5)
    .map((entry) => entry.candidate);
}

export function checkClass(known: ReadonlySet<string>, kind: string, name: string, path: string): string | Fail {
  if (known.has(name)) return name;
  return fail('PID_CLASS_UNKNOWN', `unknown ${kind} class "${name}"; close names: ${closeNames(known, name).join(', ')}`, [path]);
}

export const equipmentClass = (name: string, path: string): string | Fail => checkClass(KNOWN_EQUIPMENT_CLASSES, 'equipment', name, path);
export const pipingClassName = (name: string, path: string): string | Fail =>
  checkClass(KNOWN_PIPING_CLASSES, 'piping component', name, path);
export const isValveClass = (name: string): boolean => name.includes('Valve');
