/**
 * Default display palette `llull-ral-approx-v1` (plant 09 VIS §5.1): named colour -> display hex. A llull choice, NEVER a standard value and never
 * a pass/fail gate: no RAL / BS 4800 / ANSI Z535.1 colour has an official sRGB value. Hex = the `HEX` field of ral-colors 1.0.1 (MIT) for the RAL
 * code in `NAMED_COLOUR_RAL`; maroon and purple are llull choices (RAL not confirmed by a source). Reports always say `approximate: true`.
 */

export const PALETTE_ID = 'llull-ral-approx-v1';

const RAL_HEX: Readonly<Record<string, string>> = {
  '1021': '#f6b600',
  '2003': '#fa842b',
  '3000': '#ab2524',
  '3007': '#402225',
  '4001': '#8a5a83',
  '4008': '#904684',
  '5015': '#2874b2',
  '6018': '#48a43f',
  '7001': '#8f999f',
  '8001': '#9c6b30',
  '9005': '#0a0a0d',
  '9006': '#a5a8a6',
  '9010': '#f7f9ef',
};

/** Named colour -> RAL code (ISO 14726 Table B.1 where given; llull choices otherwise). */
const NAMED_COLOUR_RAL: Readonly<Record<string, string>> = {
  red: '3000',
  orange: '2003',
  yellow: '1021',
  brown: '8001',
  green: '6018',
  blue: '5015',
  grey: '7001',
  gray: '7001',
  silver: '9006',
  violet: '4001',
  white: '9010',
  black: '9005',
  maroon: '3007',
  purple: '4008',
};

/** Display hex of a named colour in the default palette, or undefined for a name the palette lacks. */
export function paletteHex(name: string): string | undefined {
  const ral = NAMED_COLOUR_RAL[name.toLowerCase()];
  return ral === undefined ? undefined : RAL_HEX[ral];
}
