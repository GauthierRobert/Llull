/**
 * Maximum support spacing of horizontal, water-filled, standard-wall steel pipe per nominal size.
 * Source: MSS SP-69 Table 3 / ASME B31.1 Table 121.5 "Suggested steel pipe support spacing",
 * water service (ft converted to m, one decimal): NPS ≤ 1¼ 7 ft, 1½ 9, 2 10, 2½ 11, 3 12, 4 14,
 * 5 16, 6 17, 8 19, 10 22, 12 23, 14 25, 16 27, 18 28, 20 30, 24 32 ft.
 * @layer domain-aec
 * @pure
 */

/** [DN, outside diameter mm, maximum span m]. */
const PIPE_SPAN_TABLE: ReadonlyArray<readonly [number, number, number]> = [
  [15, 21.3, 2.1],
  [20, 26.9, 2.1],
  [25, 33.7, 2.1],
  [32, 42.4, 2.1],
  [40, 48.3, 2.7],
  [50, 60.3, 3.0],
  [65, 76.1, 3.4],
  [80, 88.9, 3.7],
  [100, 114.3, 4.3],
  [125, 139.7, 4.9],
  [150, 168.3, 5.2],
  [200, 219.1, 5.8],
  [250, 273, 6.7],
  [300, 323.9, 7.0],
  [350, 355.6, 7.6],
  [400, 406.4, 8.2],
  [450, 457, 8.5],
  [500, 508, 9.1],
  [600, 610, 9.8],
];

const MATCH_TOLERANCE_MM = 1.5;

export interface PipeSpanLimit {
  /** Nominal size the span was taken for. */
  readonly dn: number;
  /** Maximum support spacing, m. */
  readonly spanM: number;
  /** True when the pipe's own DN / outside diameter is not in the table and the next smaller size was used. */
  readonly approximated: boolean;
}

/**
 * Span limit of a pipe: its tabulated `dn`, else the size whose outside diameter is within 1.5 mm
 * of `outsideDiameterMm`, else (untabulated size) the largest tabulated size with a smaller outside
 * diameter — never more span than the table allows; below DN15 the DN15 value, above DN600 the DN600 value.
 * @invariant a given DN is never rounded up
 */
export function pipeSpanLimit(dn: number | undefined, outsideDiameterMm: number): PipeSpanLimit {
  const byDn = dn === undefined ? undefined : PIPE_SPAN_TABLE.find(([size]) => size === dn);
  const entry =
    byDn ??
    PIPE_SPAN_TABLE.find(([, od]) => Math.abs(od - outsideDiameterMm) <= MATCH_TOLERANCE_MM);
  if (entry) return { dn: entry[0], spanM: entry[2], approximated: false };
  const smaller = [...PIPE_SPAN_TABLE].reverse().find(([, od]) => od < outsideDiameterMm);
  const [fallbackDn, , fallbackSpan] =
    smaller ?? (PIPE_SPAN_TABLE[0] as (typeof PIPE_SPAN_TABLE)[0]);
  return { dn: fallbackDn, spanM: fallbackSpan, approximated: true };
}

/** Typical hanger rod diameter (mm) for a nominal pipe size: M10 ≤ DN50, M12 ≤ DN100, M16 ≤ DN150, M20 ≤ DN200, M24 ≤ DN300, else M30. */
export function hangerRodDiameter(dn: number): number {
  const steps: ReadonlyArray<readonly [number, number]> = [
    [50, 10],
    [100, 12],
    [150, 16],
    [200, 20],
    [300, 24],
  ];
  return steps.find(([limit]) => dn <= limit)?.[1] ?? 30;
}
