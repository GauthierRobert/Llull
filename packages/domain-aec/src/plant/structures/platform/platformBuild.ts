/**
 * Generation of a rectangular / convex deck platform (06 STA M6): secondary beams across the bars (or the existing beams), grating panels split
 * at the supports like add_grating, and guard-rails along the chosen deck edges. The caller has put the assembly element into `base` and
 * removed its previous parts; the outcome has the parts added and the assembly updated.
 */

import type { Vec2, Vec3 } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import { polygonArea } from '@lib/polygon';
import type { AssemblyElement, BuildingModel, SteelMemberElement } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import { elementsOf, withElement } from '../../../building/model';
import { findProfile } from '../../../steel/profiles';
import { findGratingType } from '../grating/gratingTypes';
import {
  barDirection,
  bearsUnder,
  isConvex,
  isPerpendicular,
  ringFromMm,
  ringToMm,
  splitPanels,
  supportIdsOf,
  supportLineOf,
} from '../grating/gratingSupports';
import { ringPaths } from '../railing/railingPath';
import { framingBeams } from './platformGeometry';
import { overlappingPlatform } from './platformOverlap';
import {
  type PartBase,
  type PlatformOutcome,
  type Slots,
  failure,
  placeGratings,
  placeMembers,
  placeRailings,
  railingRunsProblem,
  tidyRing,
} from './platformParts';
import type { PlatformSpec } from './platformSpec';

/** Parts of a deck platform added to `base`. */
export function buildDeckPlatform(
  doc: CadDocument,
  base: BuildingModel,
  assembly: AssemblyElement,
  spec: PlatformSpec,
  slots: Slots,
): PlatformOutcome {
  const type = findGratingType(spec.gratingType);
  if (type === undefined) return failure('STA_GRATING_TYPE_UNKNOWN', `no grating type '${spec.gratingType}'`, ['gratingType']);
  const [bx, by] = spec.bearingBarDirection;
  if (!(Math.hypot(bx, by) > 0)) return failure('STA_INVALID_GEOMETRY', 'bearingBarDirection is the zero vector', ['bearingBarDirection']);
  const regionMm = ringToMm(doc, spec.boundary);
  if (!(polygonArea(regionMm) > 1) || !isConvex(regionMm))
    return failure(
      'STA_INVALID_GEOMETRY',
      'the boundary must be a convex polygon with a non-zero area (split an L shape into rectangular platforms)',
      ['boundary', 'bounds'],
    );
  const level = base.levels[assembly.levelId];
  if (level === undefined) return failure('STA_INVALID_GEOMETRY', `unknown level '${assembly.levelId}'`, ['levelId']);
  const direction = barDirection(Math.atan2(by, bx));
  const partBase: PartBase = { levelId: level.id, assemblyId: assembly.id };
  const undersideMm = toMm(doc, level.elevation + spec.topOffset) - type.barDepthMm;

  let building = base;
  let memberIds: string[] = [];
  if (spec.framing.kind === 'generated') {
    const profile = findProfile(spec.framing.profile);
    if (profile === undefined)
      return failure('STA_INVALID_GEOMETRY', `unknown framing profile '${spec.framing.profile}' (list_steel_profiles)`, ['framing']);
    const beams = framingBeams(regionMm, direction, toMm(doc, spec.framing.maxSpacing));
    if (typeof beams === 'string') return failure('STA_INVALID_GEOMETRY', beams, ['framing']);
    const z = spec.topOffset - fromMm(doc, type.barDepthMm + profile.h / 2);
    const at = ([x, y]: Vec2): Vec3 => [fromMm(doc, x), fromMm(doc, y), z];
    const placed = placeMembers(
      building,
      slots.member,
      partBase,
      'beam',
      profile.name,
      beams.map((beam) => ({ start: at(beam.start), end: at(beam.end) })),
    );
    building = placed.building;
    memberIds = placed.ids;
  }
  const members: SteelMemberElement[] =
    spec.framing.kind === 'generated'
      ? memberIds.flatMap((id) => {
          const member = building.elements[id];
          return member?.category === 'member' ? [member] : [];
        })
      : elementsOf(building, 'member').filter((member) => member.role === 'beam');
  const lines = members
    .flatMap((member) => supportLineOf(doc, building, member, direction) ?? [])
    .filter((line) => isPerpendicular(line) && bearsUnder(line, undersideMm));
  const split = splitPanels(regionMm, direction, lines);
  if (!split.ok)
    return failure(
      'STA_NO_SUPPORT_FOUND',
      `${split.reason} (${members.length} member(s) examined, ${lines.length} bear under ${undersideMm.toFixed(1)} mm)`,
      ['framing'],
    );
  const panels = split.panels.map((panel) => ({
    boundary: tidyRing(ringFromMm(doc, panel.ring)),
    supportIds: supportIdsOf(panel.supports),
  }));
  const clash = overlappingPlatform(
    doc,
    base,
    assembly.id,
    undersideMm + type.barDepthMm,
    panels.map((panel) => panel.boundary),
  );
  if (clash !== undefined)
    return failure('STA_PLATFORM_OVERLAP', `the deck overlaps platform ${clash} at the same elevation`, ['boundary', 'topOffset'], [clash]);

  const gratings = placeGratings(
    building,
    slots.grating,
    partBase,
    { topOffset: spec.topOffset, gratingType: type.name, bearingBarAngle: Math.atan2(by, bx) },
    panels,
  );
  building = gratings.building;
  let railingIds: string[] = [];
  if (spec.railing !== null) {
    const { edges, ...fields } = spec.railing;
    const runs = ringPaths(spec.boundary, spec.topOffset, edges);
    if (!runs.ok) return failure('STA_INVALID_GEOMETRY', runs.reason, ['railing']);
    const paths = runs.paths.map((run) => run.path);
    const problem = railingRunsProblem(doc, fields, paths);
    if (problem !== null) return problem;
    const placed = placeRailings(building, slots.railing, partBase, fields, paths);
    building = placed.building;
    railingIds = placed.ids;
  }
  const partIds = [...memberIds, ...gratings.ids, ...railingIds];
  return {
    ok: true,
    building: withElement(building, { ...assembly, partIds, params: spec, generation: assembly.generation + 1 }),
    partIds,
    notes: [],
  };
}
