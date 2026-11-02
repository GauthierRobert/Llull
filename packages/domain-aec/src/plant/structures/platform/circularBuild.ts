/**
 * Generation of a circular (annular-sector) platform around a vertical vessel (06 STA §5.5): radial bracket cantilevers welded to the shell,
 * one grating segment between consecutive brackets with its bars along the tangent at mid-angle, and guard-rails on the outer arc, the inner
 * arc and the sector ends. ri = OD / 2 + gap, ro = ri + width.
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import type { AssemblyElement, BuildingModel, EquipmentElement } from '@aec/building/types';
import { withElement } from '../../../building/model';
import { findProfile } from '../../../steel/profiles';
import { findGratingType } from '../grating/gratingTypes';
import { MAX_BRACKETS, MAX_POSTS, polar, railArc, sectorLayout, sectorRing } from './platformGeometry';
import { overlappingPlatform } from './platformOverlap';
import {
  type PartBase,
  type AssemblyFailure,
  type AssemblyOutcome,
  type Slots,
  failure,
  placeGratings,
  placeMembers,
  placeRailings,
  tidyRing,
} from '../assembly/assemblyParts';
import { railingRunsProblem } from './platformRailing';
import type { CircularSpec } from './platformSpec';

const RAD = Math.PI / 180;

/** The vertical vessel `equipmentId`, or the refusal when it is unknown or another kind of equipment. */
export function vesselOf(building: BuildingModel, equipmentId: string): EquipmentElement | AssemblyFailure {
  const element = building.elements[equipmentId];
  if (element === undefined) return failure('STA_UNKNOWN_ELEMENT', `no element ${equipmentId}`, ['equipmentId'], [equipmentId]);
  if (element.category !== 'equipment' || element.shape !== 'vertical_vessel')
    return failure(
      'STA_EQUIPMENT_NOT_VESSEL',
      `${equipmentId} is ${element.category === 'equipment' ? `a ${element.shape ?? 'box'} equipment` : `a ${element.category}`}, not a vertical vessel`,
      ['equipmentId'],
      [equipmentId],
    );
  return element;
}

/** Parts of a circular platform added to `base`. */
export function buildCircularPlatform(
  doc: CadDocument,
  base: BuildingModel,
  assembly: AssemblyElement,
  spec: CircularSpec,
  slots: Slots,
): AssemblyOutcome {
  const vessel = vesselOf(base, spec.equipmentId);
  if ('ok' in vessel) return vessel;
  const type = findGratingType(spec.gratingType);
  if (type === undefined) return failure('STA_GRATING_TYPE_UNKNOWN', `no grating type '${spec.gratingType}'`, ['gratingType']);
  const profile = findProfile(spec.bracketProfile);
  if (profile === undefined)
    return failure('STA_INVALID_GEOMETRY', `unknown bracket profile '${spec.bracketProfile}' (list_steel_profiles)`, ['bracketProfile']);
  const level = base.levels[vessel.levelId];
  if (level === undefined) return failure('STA_INVALID_GEOMETRY', `unknown level '${vessel.levelId}'`, ['equipmentId']);
  const [diameter, , height] = vessel.size;
  if (!(spec.elevation > 0 && spec.elevation <= height))
    return failure(
      'STA_OUTSIDE_SHELL',
      `elevation ${spec.elevation} is outside the shell of ${vessel.id}: it must be above its base and at most its height ${height} (level-relative)`,
      ['elevation'],
      [vessel.id],
    );
  const centre = vessel.location;
  const inner = diameter / 2 + spec.gap;
  const outer = inner + spec.width;
  const start = spec.startAngleDeg * RAD;
  const sweep = spec.sweepDeg * RAD;
  const layout = sectorLayout(start, sweep, outer, spec.bracketSpacingMax);
  if (layout.angles.length > MAX_BRACKETS)
    return failure(
      'STA_INVALID_GEOMETRY',
      `bracketSpacingMax gives ${layout.angles.length} brackets (limit ${MAX_BRACKETS}): check the unit and the spacing`,
      ['bracketSpacingMax'],
    );
  if (spec.railing !== null && (sweep * outer) / spec.railing.postSpacingMax > MAX_POSTS)
    return failure(
      'STA_INVALID_GEOMETRY',
      `postSpacingMax gives more than ${MAX_POSTS} posts on one railing: check the unit and the spacing`,
      ['railing'],
    );
  const partBase: PartBase = { levelId: level.id, assemblyId: assembly.id };
  const z = spec.elevation - fromMm(doc, type.barDepthMm + profile.h / 2);
  const at = (point: Vec2): Vec3 => [point[0], point[1], z];

  const brackets = placeMembers(
    base,
    slots.member,
    partBase,
    'bracket',
    profile.name,
    layout.angles.map((angle) => ({ start: at(polar(centre, diameter / 2, angle)), end: at(polar(centre, outer, angle)) })),
  );
  const segments = Array.from({ length: layout.segments }, (_, index) => {
    const [from, to] = [start + index * layout.stepRad, start + (index + 1) * layout.stepRad];
    return {
      boundary: tidyRing(sectorRing(centre, inner, outer, from, to)),
      supportIds: [[brackets.ids[index] as string], [brackets.ids[(index + 1) % brackets.ids.length] as string]] as [string[], string[]],
      barAngle: (from + to) / 2 + Math.PI / 2,
    };
  });
  const clash = overlappingPlatform(
    doc,
    base,
    assembly.id,
    toMm(doc, level.elevation + spec.elevation),
    segments.map((segment) => segment.boundary),
  );
  if (clash !== undefined)
    return failure(
      'STA_PLATFORM_OVERLAP',
      `the platform overlaps platform ${clash} at the same elevation`,
      ['elevation', 'sweepDeg'],
      [clash],
    );

  // A grating element stores one bar direction, so each segment is placed with its own tangent.
  let building = brackets.building;
  const gratingIds: string[] = [];
  segments.forEach((segment, index) => {
    const placed = placeGratings(
      building,
      slots.grating.slice(index, index + 1),
      partBase,
      { topOffset: spec.elevation, gratingType: type.name, bearingBarAngle: segment.barAngle },
      [segment],
    );
    building = placed.building;
    gratingIds.push(...placed.ids);
  });

  const railingIds: string[] = [];
  if (spec.railing !== null) {
    const { edges, ...fields } = spec.railing;
    const lift = (points: Vec2[]): Vec3[] => points.map(([x, y]) => [x, y, spec.elevation]);
    const arc = (radius: number): Vec3[] => lift(railArc(centre, radius, start, start + sweep, fields.postSpacingMax, layout.closed));
    const paths: Vec3[][] = [
      ...(edges.includes('outer') ? [arc(outer)] : []),
      ...(edges.includes('inner') ? [arc(inner)] : []),
      ...(edges.includes('ends') && !layout.closed
        ? [start, start + sweep].map((angle) => lift([polar(centre, inner, angle), polar(centre, outer, angle)]))
        : []),
    ];
    const problem = railingRunsProblem(doc, fields, paths);
    if (problem !== null) return problem;
    const placed = placeRailings(building, slots.railing, partBase, fields, paths);
    building = placed.building;
    railingIds.push(...placed.ids);
  }
  const partIds = [...brackets.ids, ...gratingIds, ...railingIds];
  return {
    ok: true,
    building: withElement(building, {
      ...assembly,
      partIds,
      params: { ...spec, vessel: { centre, diameter, height } },
      hostId: vessel.id,
      generation: assembly.generation + 1,
    }),
    partIds,
    notes: [
      `${layout.angles.length} bracket(s) every ${((layout.stepRad * 1) / RAD).toFixed(2)} deg, ${layout.segments} grating segment(s), bars skewed ${(layout.stepRad / 2 / RAD).toFixed(2)} deg from perpendicular to their brackets`,
    ],
  };
}
