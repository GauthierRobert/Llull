/**
 * Loads collected on one floor beam before its analysis: self weight, binned area loads, point loads.
 * @layer domain-aec
 */

import type { LinePiece, PointLoad } from './steelBeamAnalysis';
import { selfWeightPerMetre, topOfSteel, type SteelBar } from './steelMemberBars';

/** Width of the bins area loads are collected in along the beam, m. */
const BIN_WIDTH = 0.1;

export interface BeamLoads {
  readonly bar: SteelBar;
  readonly lengthM: number;
  /** Plan end points, mm. */
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  /** Top of steel, mm. */
  readonly top: number;
  readonly pieces: LinePiece[];
  readonly points: PointLoad[];
  /** kN per bin along the beam. */
  readonly binsPermanent: number[];
  readonly binsImposed: number[];
  /** Direct (not transferred) permanent / imposed load applied to this beam, kN. */
  directPermanent: number;
  directImposed: number;
  /** A floor bears on the top flange. */
  floorSupport: boolean;
  /** A pipe or cable tray rests on the top flange. */
  lineSupport: boolean;
}

/** Beam with its self weight as the first line piece. */
export function createBeamLoads(bar: SteelBar): BeamLoads {
  const lengthM = bar.length / 1000;
  const weight = bar.profile ? selfWeightPerMetre(bar.profile) : 0;
  const bins = Math.max(1, Math.ceil(lengthM / BIN_WIDTH));
  return {
    bar,
    lengthM,
    a: [bar.start[0], bar.start[1]],
    b: [bar.end[0], bar.end[1]],
    top: topOfSteel(bar),
    pieces: [{ from: 0, to: lengthM, permanent: weight, imposed: 0 }],
    points: [],
    binsPermanent: new Array<number>(bins).fill(0),
    binsImposed: new Array<number>(bins).fill(0),
    directPermanent: weight * lengthM,
    directImposed: 0,
    floorSupport: false,
    lineSupport: false,
  };
}

/** Add an area-load share (kN) landing `at` mm from the beam start. */
export function depositArea(beam: BeamLoads, at: number, permanent: number, imposed: number): void {
  const bins = beam.binsPermanent.length;
  const index = Math.min(bins - 1, Math.max(0, Math.floor(at / 1000 / (beam.lengthM / bins))));
  beam.binsPermanent[index] = (beam.binsPermanent[index] ?? 0) + permanent;
  beam.binsImposed[index] = (beam.binsImposed[index] ?? 0) + imposed;
  beam.directPermanent += permanent;
  beam.directImposed += imposed;
}

/** Add a point load (kN) `at` mm from the beam start; `direct` loads count toward the storey load. */
export function addPointLoad(
  beam: BeamLoads,
  at: number,
  permanent: number,
  imposed: number,
  direct: boolean,
): void {
  beam.points.push({ at: Math.min(beam.lengthM, Math.max(0, at / 1000)), permanent, imposed });
  if (direct) {
    beam.directPermanent += permanent;
    beam.directImposed += imposed;
  }
}

/** Turn the collected bins into uniform line pieces. */
export function flushBins(beam: BeamLoads): void {
  const bins = beam.binsPermanent.length;
  const width = beam.lengthM / bins;
  for (let index = 0; index < bins; index++) {
    const permanent = beam.binsPermanent[index] ?? 0;
    const imposed = beam.binsImposed[index] ?? 0;
    if (permanent === 0 && imposed === 0) continue;
    beam.pieces.push({
      from: index * width,
      to: (index + 1) * width,
      permanent: permanent / width,
      imposed: imposed / width,
    });
  }
}
