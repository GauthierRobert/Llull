/**
 * Maximum support spacing of horizontal, water-filled, standard-wall steel pipe per nominal size
 * (the span column of `PIPE_SIZES`).
 * @layer domain-aec
 * @pure
 */

import { OUTSIDE_DIAMETER_TOLERANCE_MM, PIPE_SIZES } from './pipeSizes';

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
  const byDn = dn === undefined ? undefined : PIPE_SIZES.find(([size]) => size === dn);
  const entry =
    byDn ??
    PIPE_SIZES.find(([, od]) => Math.abs(od - outsideDiameterMm) <= OUTSIDE_DIAMETER_TOLERANCE_MM);
  if (entry) return { dn: entry[0], spanM: entry[3], approximated: false };
  const smaller = [...PIPE_SIZES].reverse().find(([, od]) => od < outsideDiameterMm);
  const [fallbackDn, , , fallbackSpan] = smaller ?? (PIPE_SIZES[0] as (typeof PIPE_SIZES)[0]);
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
