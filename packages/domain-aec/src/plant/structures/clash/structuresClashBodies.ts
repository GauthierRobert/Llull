/**
 * The clash bodies of the access elements (06 STA, `check_clashes`), registered through `industrial/clash/clashSources`: fixed ladders (stiles, rungs,
 * cage hoops and bars, landing plates), steel stairs (stringers, treads, landings), grating panels and railings (posts, rails, toe plates).
 * Platform decking and rails are gratings and railings, platform members are building solids already. One body per straight part (a plate: a few strips),
 * every body carrying the id of its element, so a report names the ladder / stair / panel / railing.
 *
 * - the parts of one platform assembly (panels, railings) form one group and never clash with each other (corner posts of neighbouring edge railings coincide);
 * - railing gates are not bodies: a gate swings, and the ladder that needs one passes through it;
 * - an element never clashes with what it stands on or is part of: its platform parts, the surface a ladder / stair leaves from or arrives on (and the
 *   members, panels and railings of that surface's assembly), the supports of a panel, the host of a railing;
 * - a body with no catalogue section (a profile that left the catalogue) is skipped.
 * @invariant pure, deterministic (element order, then part order); no bodies without a level; sizes follow the document unit
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import type {
  BuildingElement,
  BuildingLevel,
  BuildingModel,
  GratingElement,
  LadderElement,
  RailingElement,
  SteelStairElement,
} from '@aec/building/types';
import { elementsOf, getBuilding } from '../../../building/model';
import type { ExternalBody } from '../../../industrial/clash/clashSources';
import type { OrientedBox } from '../../../industrial/clash/clashBoxes';
import { findProfile } from '../../../steel/profiles';
import { ladderQuantities } from '../ladder/ladderMeasure';
import { CAGE_BAR_PROFILE, HOOP_PROFILE, LANDING_THICKNESS_MM, RUNG_PROFILE, STILE_PROFILE, type LadderRun } from '../ladder/ladderLayout';
import { findGratingType } from '../grating/gratingTypes';
import { arrivalSurface, walkingSurfaces } from '../ladder/ladderSurface';
import { layoutRailing } from '../railing/railingLayout';
import { toePlateProfile } from '../railing/railingMeasure';
import { stairQuantities, treadThickness } from '../stair/steelStairMeasure';
import { plateBoxes, runBox } from './clashShapes';

/** Arc pieces of a cage hoop merged into one chord (the hoop is discretised at 5 degrees: 6 pieces are 30 degrees). */
const HOOP_PIECES_PER_BOX = 6;
/** Plan distance within which a ladder or stair counts as standing on a walking surface, and the vertical tolerance, mm. */
const SURFACE_REACH_MM = 300;
const SURFACE_Z_MM = 50;

type Emit = (box: OrientedBox | null | undefined) => void;
type Hosted = ReadonlyMap<string, readonly string[]>;

/** Ids a body standing on / belonging to `id` may touch: the element, its assembly with every part, the supports of a panel, the railings hosted on it. */
function linksOf(building: BuildingModel, hosted: Hosted, id: string): string[] {
  const links = new Set<string>([id]);
  const add = (target: BuildingElement | undefined): void => {
    if (target === undefined) return;
    links.add(target.id);
    if (target.category === 'assembly') target.partIds.forEach((part) => links.add(part));
    if (target.category === 'grating') target.supportIds.flat().forEach((support) => links.add(support));
  };
  const element = building.elements[id];
  add(element);
  if (element !== undefined && 'assemblyId' in element && element.assemblyId !== undefined) add(building.elements[element.assemblyId]);
  for (const link of [...links]) (hosted.get(link) ?? []).forEach((railing) => links.add(railing));
  return [...links];
}

function ladderBoxes(doc: CadDocument, ladder: LadderElement, level: BuildingLevel, emit: Emit): void {
  const factor = fromMm(doc, 1);
  const { layout } = ladderQuantities(doc, ladder);
  const world = (point: Vec3): Vec3 => [point[0], point[1], level.elevation + point[2]];
  const run = (name: string, part: LadderRun, roll: number, round: boolean): OrientedBox | null => {
    const profile = findProfile(name);
    if (profile === undefined) return null;
    const [u, v] = round ? [Math.max(profile.b, profile.h), Math.max(profile.b, profile.h)] : [profile.b, profile.h];
    return runBox(world(part.from), world(part.to), (u * factor) / 2, (v * factor) / 2, roll);
  };
  layout.stiles.forEach((part) => emit(run(STILE_PROFILE, part, -ladder.facing, false)));
  layout.rungs.forEach((part) => emit(run(RUNG_PROFILE, part, 0, true)));
  layout.bars.forEach((part) => emit(run(CAGE_BAR_PROFILE, part, 0, true)));
  for (let index = 0; index < layout.hoops.length; index += HOOP_PIECES_PER_BOX) {
    const chunk = layout.hoops.slice(index, index + HOOP_PIECES_PER_BOX);
    const [first, last] = [chunk[0], chunk[chunk.length - 1]];
    if (first !== undefined && last !== undefined) emit(run(HOOP_PROFILE, { from: first.from, to: last.to }, 0, false));
  }
  const thickness = LANDING_THICKNESS_MM * factor;
  for (const plate of layout.landings) {
    const top = level.elevation + plate.top;
    plateBoxes(plate.corners, ladder.facing, top - thickness, top).forEach(emit);
  }
}

function stairBoxes(doc: CadDocument, stair: SteelStairElement, level: BuildingLevel, emit: Emit): void {
  const profile = findProfile(stair.stringerProfile);
  if (profile === undefined) return;
  const { layout } = stairQuantities(doc, stair);
  const factor = fromMm(doc, 1);
  const world = (point: Vec3): Vec3 => [point[0], point[1], level.elevation + point[2]];
  layout.stringers.forEach((part) => emit(runBox(world(part.from), world(part.to), (profile.tw * factor) / 2, (profile.h * factor) / 2)));
  const thickness = treadThickness(doc, stair.tread);
  for (const plate of [...layout.treads, ...layout.landings]) {
    const top = level.elevation + plate.top;
    plateBoxes(plate.corners, stair.angle, top - thickness, top).forEach(emit);
  }
}

function gratingBoxes(doc: CadDocument, grating: GratingElement, level: BuildingLevel, emit: Emit): void {
  const type = findGratingType(grating.gratingType);
  if (type === undefined) return;
  const top = level.elevation + grating.topOffset;
  plateBoxes(grating.boundary, grating.bearingBarAngle, top - fromMm(doc, type.barDepthMm), top).forEach(emit);
}

function railingBoxes(doc: CadDocument, railing: RailingElement, level: BuildingLevel, emit: Emit): void {
  const [post, rail] = [findProfile(railing.postProfile), findProfile(railing.railProfile)];
  if (post === undefined || rail === undefined) return;
  const factor = fromMm(doc, 1);
  const layout = layoutRailing(railing, rail.h * factor);
  const world = (point: Vec3): Vec3 => [point[0], point[1], level.elevation + point[2]];
  const half = (profile: { b: number; h: number }): [number, number] => [(profile.b * factor) / 2, (profile.h * factor) / 2];
  for (const base of layout.posts) emit(runBox(world(base), world([base[0], base[1], base[2] + layout.postLength]), ...half(post)));
  layout.rails.forEach((part) => emit(runBox(world(part.from), world(part.to), ...half(rail))));
  if (railing.toePlate > 0) {
    const toe = toePlateProfile(toMm(doc, railing.toePlate));
    layout.toePlates.forEach((part) => emit(runBox(world(part.from), world(part.to), ...half(toe))));
  }
}

/** The surface a ladder or stair stands on at its foot (a slab or grating panel near it, within the vertical tolerance), as ids. */
function footLinks(doc: CadDocument, building: BuildingModel, hosted: Hosted, level: BuildingLevel, foot: Vec3, extra: number): string[] {
  const found = arrivalSurface(
    walkingSurfaces(building),
    [foot[0], foot[1]] as Vec2,
    level.elevation + foot[2],
    fromMm(doc, SURFACE_Z_MM),
    fromMm(doc, SURFACE_REACH_MM) + extra,
  );
  return found === undefined ? [] : linksOf(building, hosted, found.id);
}

/** Hosted railings of every host id (a stair carries its hand-rails). */
function hostedRailings(building: BuildingModel): Hosted {
  const hosted = new Map<string, string[]>();
  for (const railing of elementsOf(building, 'railing'))
    if (railing.host !== undefined) hosted.set(railing.host.hostId, [...(hosted.get(railing.host.hostId) ?? []), railing.id]);
  return hosted;
}

/**
 * Ids a ladder or steel stair stands on and reaches by design: itself with its hosted hand-rails, the surface it arrives on and the one it leaves from
 * (each with its assembly, panel supports and hosted railings). Bodies of these never clash with it and never obstruct its headroom.
 */
export function accessLinks(doc: CadDocument, building: BuildingModel, element: LadderElement | SteelStairElement): string[] {
  const hosted = hostedRailings(building);
  const level = building.levels[element.levelId];
  const foot = element.category === 'ladder' ? element.base : element.start;
  const extra = element.category === 'ladder' ? element.clearWidth : element.width;
  return [
    ...new Set([
      ...linksOf(building, hosted, element.id),
      ...(element.arrivalSurfaceId === undefined ? [] : linksOf(building, hosted, element.arrivalSurfaceId)),
      ...(level === undefined ? [] : footLinks(doc, building, hosted, level, foot, extra)),
    ]),
  ];
}

export function structuresClashBodies(doc: CadDocument): ExternalBody[] {
  const building = getBuilding(doc);
  const hosted = hostedRailings(building);
  const bodies: ExternalBody[] = [];
  const collect =
    (element: BuildingElement, connectedTo: readonly string[]): Emit =>
    (box) => {
      if (box !== null && box !== undefined)
        bodies.push({
          id: element.id,
          kind: 'solid',
          box,
          group: 'assemblyId' in element && element.assemblyId !== undefined ? element.assemblyId : element.id,
          connectedTo,
        });
    };

  for (const ladder of elementsOf(building, 'ladder')) {
    const level = building.levels[ladder.levelId];
    if (level === undefined) continue;
    ladderBoxes(doc, ladder, level, collect(ladder, accessLinks(doc, building, ladder)));
  }
  for (const stair of elementsOf(building, 'steelStair')) {
    const level = building.levels[stair.levelId];
    if (level === undefined) continue;
    stairBoxes(doc, stair, level, collect(stair, accessLinks(doc, building, stair)));
  }
  for (const grating of elementsOf(building, 'grating')) {
    const level = building.levels[grating.levelId];
    if (level !== undefined) gratingBoxes(doc, grating, level, collect(grating, linksOf(building, hosted, grating.id)));
  }
  for (const railing of elementsOf(building, 'railing')) {
    const level = building.levels[railing.levelId];
    if (level === undefined) continue;
    const host = railing.host === undefined ? [] : linksOf(building, hosted, railing.host.hostId);
    railingBoxes(doc, railing, level, collect(railing, [...linksOf(building, hosted, railing.id), ...host]));
  }
  return bodies;
}
