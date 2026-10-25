/** Quantities and checks inputs of a railing (06 STA M3): lengths, post count, steel mass, clear gap. */

import type { CadDocument } from '@core/model/types';
import { fromMm, toMetres, toMm } from '@core/model/units';
import { STEEL_DENSITY_KG_PER_M3, findProfile, type SteelProfile } from '../../../steel/profiles';
import type { RailingElement } from '@aec/building/types';
import { layoutRailing, type RailRun, type RailingLayout } from './railingLayout';

/** Toe plates are flat bars of this thickness, mm. */
export const TOE_PLATE_THICKNESS_MM = 5;

/** Catalogue-shaped flat bar of a toe plate `heightMm` high (for outlines and IFC profiles). */
export const toePlateProfile = (heightMm: number): SteelProfile => ({
  name: `FL${Math.round(heightMm * 10) / 10}x${TOE_PLATE_THICKNESS_MM}`,
  family: 'FL',
  shape: 'FL',
  h: heightMm,
  b: TOE_PLATE_THICKNESS_MM,
  tw: TOE_PLATE_THICKNESS_MM,
  tf: TOE_PLATE_THICKNESS_MM,
  lip: 0,
  massPerMetre: (heightMm * TOE_PLATE_THICKNESS_MM * STEEL_DENSITY_KG_PER_M3) / 1e6,
  area: heightMm * TOE_PLATE_THICKNESS_MM,
  perimeter: 2 * (heightMm + TOE_PLATE_THICKNESS_MM),
});

const runLength = (run: RailRun): number => Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1], run.to[2] - run.from[2]);
const total = (runs: ReadonlyArray<RailRun>): number => runs.reduce((sum, run) => sum + runLength(run), 0);

export interface RailingQuantities {
  readonly layout: RailingLayout;
  readonly lengthM: number;
  readonly posts: number;
  readonly railLengthM: number;
  readonly gateRailLengthM: number;
  readonly gates: number;
  readonly toeLengthM: number;
  readonly postKg: number;
  readonly railKg: number;
  readonly toeKg: number;
  readonly steelKg: number;
  readonly clearGapMm: number;
  /** Largest distance between neighbouring posts, mm. */
  readonly postSpacingMm: number;
}

/** The layout and totals of a railing; null when a profile left the catalogue. */
export function railingQuantities(doc: CadDocument, railing: RailingElement): RailingQuantities | null {
  const post = findProfile(railing.postProfile);
  const rail = findProfile(railing.railProfile);
  if (post === undefined || rail === undefined) return null;
  const layout = layoutRailing(railing, fromMm(doc, rail.h));
  const metres = toMetres(doc, 1);
  const posts = layout.posts.length;
  const railM = total(layout.rails) * metres;
  const gateM = total(layout.gates) * metres;
  const toeM = total(layout.toePlates) * metres;
  const postKg = posts * layout.postLength * metres * post.massPerMetre;
  const railKg = (railM + gateM) * rail.massPerMetre;
  const toeKg = toeM * toePlateProfile(toMm(doc, railing.toePlate)).massPerMetre;
  const spacings = layout.posts
    .slice(1)
    .map((point, index) => Math.hypot(...point.map((value, axis) => value - (layout.posts[index]?.[axis] ?? 0))));
  return {
    layout,
    lengthM: layout.length * metres,
    posts,
    railLengthM: railM,
    gateRailLengthM: gateM,
    gates: new Set(layout.gates.map((gate) => gate.opening)).size,
    toeLengthM: toeM,
    postKg,
    railKg,
    toeKg,
    steelKg: postKg + railKg + toeKg,
    clearGapMm: toMm(doc, layout.clearGap),
    postSpacingMm: toMm(doc, Math.max(0, ...spacings)),
  };
}
