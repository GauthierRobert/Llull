// Engineering-prefixed value text (N, W, Pa, N·m): the number an engineer reads at a glance, never an exponent.

const PREFIXES: readonly (readonly [number, string])[] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
];

/** `value` in SI `unit` with the prefix that keeps 1-999 in front, 3 significant digits: 22 200 N → "22.2 kN", 5.67e-4 N → "567 µN". */
export function formatSi(value: number, unit: string): string {
  if (value === 0 || !Number.isFinite(value)) return `${value === 0 ? 0 : value} ${unit}`;
  const magnitude = Math.abs(value);
  const [factor, prefix] = PREFIXES.find(([scale]) => magnitude >= scale) ?? PREFIXES[PREFIXES.length - 1] ?? [1, ''];
  return `${Number((value / factor).toPrecision(3))} ${prefix}${unit}`;
}
