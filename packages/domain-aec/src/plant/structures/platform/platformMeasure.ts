/**
 * Quantities of a platform assembly (06 STA M6): deck area and grating mass, railing length and posts, framing steel, sector geometry.
 * A circular platform reports the true annular sector (area theta/2 (ro2 - ri2), arcs theta r, VC-STA-07) next to the area of the chord
 * polygons it is modelled with (`panelAreaM2`, up to 0.13 % lower at 5 deg chords).
 */

import type { CadDocument } from '@core/model/types';
import { toMetres, toMm } from '@core/model/units';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import { findGratingType } from '../grating/gratingTypes';
import { gratingAreaM2, gratingMassKg } from '../grating/gratingMeasure';
import { railingQuantities } from '../railing/railingMeasure';
import { circularSpecSchema } from './platformSpec';

export interface PlatformQuantities {
  readonly id: string;
  readonly mark: string;
  readonly kind: AssemblyElement['kind'];
  readonly level: string;
  readonly panels: number;
  /** Deck: the panel areas. Circular: the true sector area. */
  readonly gratingAreaM2: number;
  /** Area of the grating polygons as modelled. */
  readonly panelAreaM2: number;
  readonly gratingMassKg: number;
  /** Beams (deck) or brackets (circular). */
  readonly members: number;
  readonly memberLengthM: number;
  readonly memberKg: number;
  readonly railings: number;
  /** Guarded length: the path lengths less the openings; circular: along the true arcs. */
  readonly railingLengthM: number;
  readonly posts: number;
  readonly railingKg: number;
  /** Members and railings. */
  readonly steelKg: number;
  readonly totalKg: number;
  /** Circular platforms only (null on a deck). */
  readonly bracketCount: number | null;
  readonly innerRadiusMm: number | null;
  readonly outerRadiusMm: number | null;
  readonly sweepDeg: number | null;
  readonly innerArcM: number | null;
  readonly outerArcM: number | null;
  /** Posts of the outer-arc railing (null without one). */
  readonly outerRailPosts: number | null;
}

/** Totals over the parts of `assembly` as they are in `building` (read from the stored elements, nothing is regenerated). */
export function platformQuantities(doc: CadDocument, building: BuildingModel, assembly: AssemblyElement): PlatformQuantities {
  const metres = toMetres(doc, 1);
  let panels = 0;
  let panelAreaM2 = 0;
  let panelKg = 0;
  let members = 0;
  let memberLengthM = 0;
  let memberKg = 0;
  let railings = 0;
  let guardedM = 0;
  let posts = 0;
  let railingKg = 0;
  let firstRailingPosts: number | null = null;
  for (const id of assembly.partIds) {
    const part = building.elements[id];
    if (part?.category === 'grating') {
      panels += 1;
      panelAreaM2 += gratingAreaM2(doc, part);
      panelKg += gratingMassKg(doc, part);
    } else if (part?.category === 'member') {
      const length = Math.hypot(part.end[0] - part.start[0], part.end[1] - part.start[1], part.end[2] - part.start[2]) * metres;
      members += 1;
      memberLengthM += length;
      memberKg += length * (findProfile(part.profile)?.massPerMetre ?? 0);
    } else if (part?.category === 'railing') {
      const quantities = railingQuantities(doc, part);
      railings += 1;
      guardedM += (quantities?.lengthM ?? 0) - part.openings.reduce((sum, opening) => sum + (opening.to - opening.from) * metres, 0);
      posts += quantities?.posts ?? 0;
      railingKg += quantities?.steelKg ?? 0;
      firstRailingPosts ??= quantities?.posts ?? 0;
    }
  }
  const parsed = assembly.kind === 'circular_platform' ? circularSpecSchema.safeParse(assembly.params) : null;
  const spec = parsed?.success === true ? parsed.data : null;
  const vessel = spec?.vessel;
  const type = spec === null ? undefined : findGratingType(spec.gratingType);
  let circular: Partial<PlatformQuantities> = {};
  let railingLengthM = guardedM;
  let gratingAreaTotal = panelAreaM2;
  let gratingMassTotal = panelKg;
  if (spec !== null && vessel !== undefined) {
    const sweep = (spec.sweepDeg * Math.PI) / 180;
    const inner = vessel.diameter / 2 + spec.gap;
    const outer = inner + spec.width;
    const edges = spec.railing?.edges ?? [];
    const gaps = (spec.railing?.openings ?? []).reduce((sum, opening) => sum + opening.to - opening.from, 0);
    gratingAreaTotal = (sweep / 2) * (outer * outer - inner * inner) * metres * metres;
    gratingMassTotal = gratingAreaTotal * (type?.massKgM2 ?? 0);
    railingLengthM =
      ((edges.includes('outer') ? sweep * outer : 0) +
        (edges.includes('inner') ? sweep * inner : 0) +
        (edges.includes('ends') && spec.sweepDeg < 360 ? 2 * (outer - inner) : 0) -
        gaps) *
      metres;
    circular = {
      bracketCount: members,
      innerRadiusMm: round(toMm(doc, inner), 4),
      outerRadiusMm: round(toMm(doc, outer), 4),
      sweepDeg: spec.sweepDeg,
      innerArcM: round(sweep * inner * metres, 6),
      outerArcM: round(sweep * outer * metres, 6),
      outerRailPosts: edges.includes('outer') ? firstRailingPosts : null,
    };
  }
  const steelKg = memberKg + railingKg;
  return {
    id: assembly.id,
    mark: assembly.mark,
    kind: assembly.kind,
    level: building.levels[assembly.levelId]?.name ?? assembly.levelId,
    panels,
    gratingAreaM2: round(gratingAreaTotal, 6),
    panelAreaM2: round(panelAreaM2, 6),
    gratingMassKg: round(gratingMassTotal, 3),
    members,
    memberLengthM: round(memberLengthM, 4),
    memberKg: round(memberKg, 3),
    railings,
    railingLengthM: round(railingLengthM, 6),
    posts,
    railingKg: round(railingKg, 3),
    steelKg: round(steelKg, 3),
    totalKg: round(steelKg + gratingMassTotal, 3),
    bracketCount: null,
    innerRadiusMm: null,
    outerRadiusMm: null,
    sweepDeg: null,
    innerArcM: null,
    outerArcM: null,
    outerRailPosts: null,
    ...circular,
  };
}
