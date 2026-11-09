/** 14 FLL-M3 fixtures: the 2 x 1 x 1 mm steel bar of deckFixtures printed with a known coupon set; synthetic test values, not data of any printer. */
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { barDocument, mustRun, type Bar } from './deckFixtures';

export const COUPON_SOURCE = { citation: 'synthetic test coupon set', locator: 'tests/unit/cae/printFixtures.ts' };

/** Solid coupons: E_xy 2000 MPa, E_z 1500 MPa (ratio 0.75), strengths 30 / 20 MPa. */
export const SOLID_COUPON = {
  E_xy: { value: 2000, unit: 'MPa' },
  E_z: { value: 1.5, unit: 'GPa' },
  uts_xy: { value: 30, unit: 'MPa' },
  uts_z: { value: 20, unit: 'MPa' },
  source: COUPON_SOURCE,
};

/** 0.1 mm walls, one 0.1 mm top / bottom layer: first-order skin fraction of the 2 x 1 x 1 bar along z = 1 / 2. */
export const BAR_PRINT = {
  walls: 1,
  lineWidthMm: 0.1,
  layerHeightMm: 0.1,
  topBottomLayers: 1,
  infill: { pattern: 'gyroid', density: 0.4 },
  layerAxis: [0, 0, 1],
  coupon: SOLID_COUPON,
  infillExponent: { value: 1.5, source: { citation: 'synthetic exponent' } },
} as const;

export interface PrintedBar extends Bar {
  /** The bar with its printed idealization set. */
  readonly printed: CadDocument;
}

export function printedBar(overrides: Record<string, unknown> = {}): PrintedBar {
  const bar = barDocument();
  const result = execute(bar.doc, 'set_print_idealization', {
    analysisId: bar.analysisId,
    entityId: bar.boxId,
    ...BAR_PRINT,
    ...overrides,
  });
  if (result.rejected === true) throw new Error(result.summary);
  return { ...bar, printed: result.document };
}

/** Records one coupon; throws on refusal. */
export function recordCoupon(
  doc: CadDocument,
  id: string,
  density: number,
  direction: 'xy' | 'z',
  modulusMpa: number,
  pattern = 'gyroid',
  skinFraction = 0,
): CadDocument {
  return mustRun(doc, 'record_print_coupon', {
    id,
    pattern,
    skinFraction,
    infillDensity: density,
    direction,
    modulus: { value: modulusMpa, unit: 'MPa' },
    source: COUPON_SOURCE,
  });
}
