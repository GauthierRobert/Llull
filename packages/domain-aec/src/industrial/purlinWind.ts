/**
 * Wind zone selection of one roof purlin (EN 1991-1-4 via windCoefficients).
 * @layer domain-aec
 */

import { FLAT_ROOF_LIMIT, roofCoefficients } from './windCoefficients';
import { DOWNWIND_ROOF_FACTOR } from './frameModelTypes';
import { pressureOf, suctionOf, TOLERANCE, zoneOf, round } from './purlinModel';
import type { Located, WindOption } from './purlinModel';

interface HallEnvelope {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly yEnd: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly eAcross: number;
  readonly eAlong: number;
}

interface PurlinWindInput {
  readonly purlin: Located;
  readonly eavesEnd: Located;
  readonly highEnd: Located;
  readonly pitchDegrees: number;
  readonly monopitch: boolean;
  readonly valleys: ReadonlyArray<number>;
  readonly envelope: HallEnvelope;
}

interface PurlinWind {
  readonly zone: string;
  readonly direction: string;
  readonly cpe: number;
  readonly pressureOption: WindOption;
}

/** Governing uplift zone and the worst downward-pressure zone of a purlin. */
export function purlinWind(input: PurlinWindInput): PurlinWind {
  const { purlin, eavesEnd, highEnd, pitchDegrees, monopitch, valleys } = input;
  const { x0, x1, y0, yEnd, width, depth, height, eAcross, eAlong } = input.envelope;
  // Wind zones (EN 1991-1-4 via windCoefficients.ts at this purlin's pitch).
  const horizontalEaves = Math.abs(purlin.start[0] - eavesEnd.start[0]);
  const horizontalRidge = Math.abs(purlin.start[0] - highEnd.start[0]);
  const nearGable = (distance: number): boolean =>
    purlin.yMin - y0 < distance - TOLERANCE || yEnd - purlin.yMax < distance - TOLERANCE;
  const along = roofCoefficients(monopitch ? 'monopitch' : 'duopitch', pitchDegrees, 90);
  const alongZone: 'F' | 'G' | 'H' | 'I' = nearGable(eAlong / 10)
    ? horizontalEaves <= eAlong / 4 + TOLERANCE
      ? 'F'
      : 'G'
    : nearGable(eAlong / 2)
      ? 'H'
      : 'I';
  const alongOption: WindOption = {
    zone: alongZone,
    cpe: suctionOf(zoneOf(along, alongZone)),
    pressure: 0,
    direction: '',
  };
  let options: WindOption[];
  if (pitchDegrees < FLAT_ROOF_LIMIT) {
    // Tab. 7.2: zones around the perimeter (F corners e/4 x e/10, G strips e/10, H to e/2, I inside).
    const flat = roofCoefficients('flat', pitchDegrees, 0);
    const eFlat = Math.min(width, depth, 2 * height);
    const edgeX = Math.min(purlin.start[0] - x0, x1 - purlin.start[0]);
    const edgeY = Math.min(purlin.yMin - y0, yEnd - purlin.yMax);
    const [nearest, farthest] = [Math.min(edgeX, edgeY), Math.max(edgeX, edgeY)];
    const flatZone: 'F' | 'G' | 'H' | 'I' =
      nearest <= eFlat / 10 + TOLERANCE
        ? farthest <= eFlat / 4 + TOLERANCE
          ? 'F'
          : 'G'
        : nearest <= eFlat / 2
          ? 'H'
          : 'I';
    options = [
      {
        zone: flatZone === 'H' || flatZone === 'I' ? 'H/I' : flatZone,
        cpe: suctionOf(flat[flatZone]),
        pressure: pressureOf(flat[flatZone]),
        direction: '',
      },
    ];
  } else if (monopitch) {
    const monopitchZone = (distance: number): 'F' | 'G' | 'H' =>
      distance <= eAcross / 10 + TOLERANCE ? (nearGable(eAcross / 4) ? 'F' : 'G') : 'H';
    const [low, high] = [
      roofCoefficients('monopitch', pitchDegrees, 0),
      roofCoefficients('monopitch', pitchDegrees, 180),
    ];
    const [lowZone, highZone] = [
      monopitchZone(horizontalEaves),
      monopitchZone(Math.abs(purlin.start[0] - highEnd.start[0])),
    ];
    options = [
      {
        zone: lowZone,
        cpe: suctionOf(low[lowZone]),
        pressure: pressureOf(low[lowZone]),
        direction: ' (θ = 0°, wind on the low eaves)',
      },
      {
        zone: highZone,
        cpe: suctionOf(high[highZone]),
        pressure: 0,
        direction: ' (θ = 180°, wind on the high eaves)',
      },
      { ...alongOption, direction: ' (θ = 90°, wind along the eaves)' },
    ];
  } else {
    const across = roofCoefficients('duopitch', pitchDegrees, 0);
    // Multi-span (EN 1991-1-4 Fig. 7.10, simplified): a span between two valleys is downwind
    // of the windward span for either wind direction: zone H/I with the 0.6 reduction.
    const spanIndex = valleys.filter((valley) => valley < purlin.start[0]).length;
    if (spanIndex > 0 && spanIndex < valleys.length) {
      options = [
        {
          zone: 'H/I',
          cpe: DOWNWIND_ROOF_FACTOR * Math.min(suctionOf(across.H), suctionOf(across.I)),
          pressure: 0,
          direction: '',
        },
      ];
    } else {
      const windwardZone: 'F' | 'G' | 'H' =
        horizontalEaves <= eAcross / 10 + TOLERANCE ? (nearGable(eAcross / 4) ? 'F' : 'G') : 'H';
      const leewardZone: 'I' | 'J' = horizontalRidge <= eAcross / 10 + TOLERANCE ? 'J' : 'I';
      options = [
        {
          zone: windwardZone === 'H' ? 'H/I' : windwardZone,
          cpe: suctionOf(across[windwardZone]),
          pressure: pressureOf(across[windwardZone]),
          direction: '',
        },
        {
          zone: leewardZone === 'I' ? 'H/I' : leewardZone,
          cpe: suctionOf(across[leewardZone]),
          pressure: 0,
          direction: '',
        },
      ];
    }
  }
  const candidates =
    monopitch || pitchDegrees < FLAT_ROOF_LIMIT ? options : [...options, alongOption];
  const upliftOption = candidates.reduce((worstCase, option) =>
    option.cpe < worstCase.cpe ? option : worstCase,
  );
  const { zone, direction } = upliftOption;
  const cpe = round(upliftOption.cpe, 3);
  const pressureOption = options.reduce((best, option) =>
    option.pressure > best.pressure ? option : best,
  );
  return { zone, direction, cpe, pressureOption };
}
