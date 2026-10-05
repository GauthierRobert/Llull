/**
 * Base plate under moment + axial force (EN 1993-1-8 §6.2.8, simplified): concrete bearing block with
 * fjd on the compression side, anchor bolts on the other, plate bending, and a catalogue sizing.
 * @layer domain-aec
 * @pure
 */

import { anchorBoltResistance } from './steelDesign';
import { FCD } from './footingModel';
import { MAX_UTILISATION } from './foundationModel';

const CONCENTRATION_FACTOR = 1.5;
/** Concrete bearing strength fjd = 2/3 × 1.5 × fcd (C25/30), N/mm². */
export const BEARING_STRENGTH = (2 / 3) * FCD * CONCENTRATION_FACTOR;
const BISECTION_STEPS = 60;
const MIN_TENSION_LEVER = 20;

/** Plate and column sizes in mm. */
interface PlateMnGeometry {
  /** Along the column depth (the frame plane). */
  readonly length: number;
  readonly width: number;
  readonly thickness: number;
  readonly boltCount: number;
  readonly boltDiameter: number;
  /** Column depth h, mm. */
  readonly columnDepth: number;
}

interface PlateMnCheck {
  readonly utilisation: number;
  /** Tension per bolt on the tension side, kN (0 without tension). */
  readonly boltTension: number;
  readonly boltLimit: number;
  /** Concrete bearing block length c, mm. */
  readonly bearingLength: number;
  readonly requiredThickness: number;
  readonly check: string;
}

/** Distance of the bolt columns from the plate centre along the length (as laid out in plateLayout). */
function boltOffsets(geometry: PlateMnGeometry): number[] {
  const columns = Math.max(1, geometry.boltCount / 2);
  const edge = Math.max(2 * geometry.boltDiameter, 40);
  return Array.from({ length: columns }, (_, index) =>
    columns === 1
      ? 0
      : -geometry.length / 2 + edge + ((geometry.length - 2 * edge) * index) / (columns - 1),
  );
}

/**
 * Checks the plate for a compression N (kN, negative = uplift) and a moment M (kN·m, sign ignored):
 * Ft = max(0, (M − N zc) / z) with zc the lever from the column axis to the centroid of the bearing
 * block (length c = (N + Ft) / (B fjd)) and z that centroid to the tension bolts; uplift without a
 * bearing block shares N and M between the two bolt groups. Utilisation = max of bolt tension,
 * bearing length against the distance between the bolt lines, and plate bending (cantilever beyond
 * the flange, t ≥ c √(3 fjd / fy), and bolt prying lever of the tension row).
 * @pure
 */
export function checkPlateMN(
  geometry: PlateMnGeometry,
  normal: number,
  moment: number,
  yieldStrength: number,
): PlateMnCheck {
  const { length, width, thickness, boltDiameter, columnDepth } = geometry;
  const [axial, bending] = [normal * 1000, Math.abs(moment) * 1e6];
  const offsets = boltOffsets(geometry).filter((offset) => offset > 1e-6);
  const boltsPerSide = 2 * offsets.length;
  const lever =
    offsets.length > 0 ? offsets.reduce((sum, value) => sum + value, 0) / offsets.length : 0;
  const edge = Math.max(2 * boltDiameter, 40);
  const maxBlock = Math.max(length - 2 * edge, 1);
  const bearingForce = width * BEARING_STRENGTH;
  const tensionOf = (block: number): number => {
    const centroid = length / 2 - block / 2;
    const arm = centroid + lever;
    return arm > 0 ? Math.max(0, (bending - axial * centroid) / arm) : Number.POSITIVE_INFINITY;
  };
  const gap = (block: number): number => block * bearingForce - axial - tensionOf(block);
  let block = 0;
  let tension = tensionOf(0);
  let bearing = 0;
  if (gap(0) >= 0 && axial + tension <= 0) {
    // Net uplift without a compression zone: both bolt groups in tension.
    tension = lever > 0 ? (-axial + bending / lever) / 2 : Number.POSITIVE_INFINITY;
    tension = Math.max(tension, 0);
  } else {
    let [low, high] = [0, maxBlock];
    if (gap(high) < 0) {
      block = maxBlock;
    } else {
      for (let step = 0; step < BISECTION_STEPS; step++) {
        const middle = (low + high) / 2;
        if (gap(middle) < 0) low = middle;
        else high = middle;
      }
      block = high;
    }
    tension = tensionOf(block);
    bearing = (axial + tension) / (bearingForce * maxBlock);
  }
  const perBolt =
    boltsPerSide > 0 ? tension / boltsPerSide : tension > 0 ? Number.POSITIVE_INFINITY : 0;
  const boltLimit = anchorBoltResistance(boltDiameter).tension;
  const boltRatio = perBolt / boltLimit;
  const overhang = Math.max(0, (length - columnDepth) / 2);
  const compressionLength = Math.min(block, overhang);
  const prying = Math.max(overhang - edge, MIN_TENSION_LEVER);
  const requiredCompression = compressionLength * Math.sqrt((3 * BEARING_STRENGTH) / yieldStrength);
  const requiredTension = Math.sqrt((4 * tension * prying) / (width * yieldStrength));
  const requiredThickness = Math.max(requiredCompression, requiredTension);
  const utilisation = Math.min(
    Math.max(boltRatio, bearing, requiredThickness / thickness),
    MAX_UTILISATION,
  );
  return {
    utilisation,
    boltTension: Number.isFinite(perBolt) ? perBolt / 1000 : MAX_UTILISATION,
    boltLimit: boltLimit / 1000,
    bearingLength: block,
    requiredThickness,
    check:
      `bolt Ft ${Number.isFinite(perBolt) ? (perBolt / 1000).toFixed(1) : '∞'}/${(boltLimit / 1000).toFixed(1)} kN, ` +
      `bearing c ${block.toFixed(0)}/${maxBlock.toFixed(0)} mm (fjd ${BEARING_STRENGTH.toFixed(1)} N/mm²), ` +
      `plate t ${thickness.toFixed(0)} ≥ ${requiredThickness.toFixed(1)} mm`,
  };
}

interface PlateSizing {
  /** Overhang beyond the column profile on each side, mm. */
  readonly margin: number;
  readonly thickness: number;
  readonly boltCount: number;
  readonly boltDiameter: number;
}

const MARGINS = [100, 150, 200, 250, 300] as const;
const THICKNESSES = [25, 30, 40, 50] as const;
const BOLTS = [
  [4, 24],
  [4, 30],
  [6, 30],
  [8, 30],
  [8, 36],
  [10, 36],
  [12, 36],
] as const;
/** Anchor bolt columns along the plate keep a clear pitch of at least 3 d. */
const MIN_PITCH_FACTOR = 3;

/** Catalogue of plate sizes, lightest (plate mass, then bolt area) first. */
const CATALOGUE: ReadonlyArray<PlateSizing> = MARGINS.flatMap((margin) =>
  THICKNESSES.flatMap((thickness) =>
    BOLTS.map(([boltCount, boltDiameter]) => ({ margin, thickness, boltCount, boltDiameter })),
  ),
).sort(
  (a, b) =>
    a.margin * a.thickness - b.margin * b.thickness ||
    a.boltCount * a.boltDiameter ** 2 - b.boltCount * b.boltDiameter ** 2,
);

export interface PlateDemand {
  /** Compression kN (negative = uplift) and moment kN·m. */
  readonly normal: number;
  readonly moment: number;
}

/**
 * Lightest catalogue plate (margin 100–300 mm, t 25–50 mm, 4–12 bolts M24–M36) that passes every
 * demand with utilisation ≤ `target`; the most capable one when none does.
 * @pure
 */
export function sizeBasePlate(
  column: { readonly depth: number; readonly width: number },
  demands: ReadonlyArray<PlateDemand>,
  yieldStrength: number,
  target = 1,
): { sizing: PlateSizing; passes: boolean } {
  let best: { sizing: PlateSizing; worst: number } | null = null;
  for (const sizing of CATALOGUE) {
    const geometry: PlateMnGeometry = {
      length: column.depth + 2 * sizing.margin,
      width: column.width + 2 * sizing.margin,
      thickness: sizing.thickness,
      boltCount: sizing.boltCount,
      boltDiameter: sizing.boltDiameter,
      columnDepth: column.depth,
    };
    const columns = sizing.boltCount / 2;
    const edge = Math.max(2 * sizing.boltDiameter, 40);
    if (
      columns > 1 &&
      (geometry.length - 2 * edge) / (columns - 1) < MIN_PITCH_FACTOR * sizing.boltDiameter
    ) {
      continue;
    }
    const worst = Math.max(
      0,
      ...demands.map(
        (demand) => checkPlateMN(geometry, demand.normal, demand.moment, yieldStrength).utilisation,
      ),
    );
    if (worst <= target) return { sizing, passes: true };
    if (best === null || worst < best.worst) best = { sizing, worst };
  }
  return { sizing: (best as { sizing: PlateSizing }).sizing, passes: false };
}
