/** Length conversion of the data sheet: every length of a record is written in millimetres whatever the document unit, under a key with the `Mm` suffix. */

export type Obj = Record<string, unknown>;

/** Keys that hold a length (or an array / object of lengths) in document units in the stored template, design, nozzles and volume results. */
export const LENGTH_KEYS: ReadonlySet<string> = new Set([
  'insideDiameter',
  'tangentLength',
  'shellThickness',
  'headThickness',
  'corrosionAllowance',
  'height',
  'thickness',
  'baseRingWidth',
  'pitchDiameter',
  'legWidth',
  'width',
  'axisElevation',
  'baseElevation',
  'stations',
  'diameter',
  'shellHeight',
  'courses',
  'courseThicknesses',
  'radius',
  'length',
  'pitch',
  'outsideDiameter',
  'wallThickness',
  'shellInsideDiameter',
  'tubesheetThickness',
  'a',
  'f',
  'h1',
  'h2',
  'gap',
  'crownRadius',
  'knuckleRadius',
  'spacing',
  'firstElevation',
  'elevation',
  'depth',
  'designLiquidLevel',
  'levelAboveBottomTangent',
  'insideHeight',
  'headDepths',
  'level',
  'insideOverallLength',
  'shellLength',
  'projection',
  'station',
  'radialOffset',
  'neckOutsideDiameter',
  'neckWall',
  'position',
]);

/** Keys whose millimetre twin is already in the same object (the converted copy would repeat it). */
const REDUNDANT_KEYS: ReadonlySet<string> = new Set(['insideOverallLength']);

const round = (value: number): number => Math.round(value * 1e9) / 1e9 + 0;

/**
 * `value` with every length key renamed `<key>Mm` and scaled by `mm` (millimetres per document unit), recursively; other keys are copied.
 * @invariant pure; a key only converts when its value is a number, or an array / object of numbers
 */
export function toMillimetres(value: unknown, mm: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => toMillimetres(entry, mm));
  if (value === null || typeof value !== 'object') return value;
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (REDUNDANT_KEYS.has(key) && `${key}Mm` in value) continue;
    if (!LENGTH_KEYS.has(key)) entries.push([key, toMillimetres(entry, mm)]);
    else if (typeof entry === 'number') entries.push([`${key}Mm`, round(entry * mm)]);
    else if (Array.isArray(entry) && entry.every((item) => typeof item === 'number'))
      entries.push([`${key}Mm`, entry.map((item: number) => round(item * mm))]);
    else if (entry !== null && typeof entry === 'object' && Object.values(entry).every((item) => typeof item === 'number'))
      entries.push([`${key}Mm`, Object.fromEntries(Object.entries(entry).map(([name, item]) => [name, round((item as number) * mm)]))]);
    else entries.push([key, toMillimetres(entry, mm)]);
  }
  return Object.fromEntries(entries);
}

export const millimetres = (value: number, mm: number): number => round(value * mm);
