/** Maximum support spacing of horizontal standard-wall steel pipe per nominal size: water-filled (`PIPE_SIZES`) or gas / air / steam. */

import { PIPE_SIZES, pipeSizeByOutsideDiameter } from './pipeSizes';

/**
 * Typical support spacing (m) of horizontal, standard-wall steel pipe in steam / gas / air service per DN: the "steam, gas or air" column of
 * ASME B31.1 Table 121.5 / MSS SP-69 Table 3 (NPS 1 9 ft, 2 13, 3 15, 4 17, 6 21, 8 24, 12 30, 16 35, 20 39, 24 42 ft), intermediate NPS
 * interpolated, ft converted to m (one decimal). Typical suggested values, not a quoted clause: verify against the project code edition.
 */
// prettier-ignore
const GAS_SPANS_M: Readonly<Record<number, number>> = {
  15: 2.7, 20: 2.7, 25: 2.7, 32: 2.7, 40: 3.7, 50: 4.0, 65: 4.3, 80: 4.6, 100: 5.2, 125: 5.8, 150: 6.4, 200: 7.3, 250: 8.2, 300: 9.1,
  350: 10.1, 400: 10.7, 450: 11.3, 500: 11.9, 600: 12.8,
};

const GAS_SERVICE = /\b(air|gas|steam|vapou?r|nitrogen|oxygen|hydrogen|methane)\b/i;

/** True when a service text names a gas, air, steam or vapour line (lighter than water-filled pipe: the longer span column applies). */
export function isGasService(service: string | undefined): boolean {
  return GAS_SERVICE.test(service ?? '');
}

interface PipeSpanLimit {
  /** Nominal size the span was taken for. */
  readonly dn: number;
  /** Maximum support spacing, m. */
  readonly spanM: number;
  /** True when the pipe's own DN / outside diameter is not in the table and the next smaller size was used. */
  readonly approximated: boolean;
}

/**
 * Span limit of a pipe: its tabulated `dn`, else the size whose outside diameter is within 1.5 mm of `outsideDiameterMm`, else (untabulated
 * size) the largest tabulated size with a smaller outside diameter — never more span than the table allows; below DN15 the DN15 value,
 * above DN600 the DN600 value.
 * Gas / air / steam services (`isGasService(service)`) take the gas column, other services the water-filled one.
 * @invariant a given DN is never rounded up
 */
export function pipeSpanLimit(dn: number | undefined, outsideDiameterMm: number, service?: string): PipeSpanLimit {
  const spanOf = (size: number, water: number): number => (isGasService(service) ? (GAS_SPANS_M[size] ?? water) : water);
  const byDn = dn === undefined ? undefined : PIPE_SIZES.find(([size]) => size === dn);
  const entry = byDn ?? pipeSizeByOutsideDiameter(outsideDiameterMm);
  if (entry) return { dn: entry[0], spanM: spanOf(entry[0], entry[3]), approximated: false };
  const smaller = [...PIPE_SIZES].reverse().find(([, od]) => od < outsideDiameterMm);
  const [fallbackDn, , , fallbackWater] = smaller ?? (PIPE_SIZES[0] as (typeof PIPE_SIZES)[0]);
  return { dn: fallbackDn, spanM: spanOf(fallbackDn, fallbackWater), approximated: true };
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
