/**
 * Seeds of the IFC products `export_ifc` writes for one building element, mirroring each exporter's own "no product" conditions and calling the same
 * seed helpers (`exchange/ifcSeeds.ts`). Consumed by `projections.ts` (BCF IfcGuid and its inverse).
 * @invariant pure; a seed is listed only when the exporter writes that product for the document as it is
 * @failure element not exported (level not in levelOrder, host wall missing / not written, catalogue entry gone, degenerate geometry, unlisted category) -> []
 */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { IfcSchemaName } from '@core/plugins/plugin';
import { carrierOfSupport } from '../industrial/piping/pipeCarrier';
import { buildingConnectionSolids, plateLayout } from '../industrial/connections/evaluateConnections';
import { panelFrame } from '../industrial/evaluate';
import { findGratingType } from '../plant/structures/grating/gratingTypes';
import { CAGE_BAR_PROFILE, HOOP_PROFILE, RUNG_PROFILE, STILE_PROFILE } from '../plant/structures/ladder/ladderLayout';
import { ladderQuantities } from '../plant/structures/ladder/ladderMeasure';
import { railingQuantities } from '../plant/structures/railing/railingMeasure';
import { stairQuantities, treadThickness } from '../plant/structures/stair/steelStairMeasure';
import { sweepFrame } from '../shared/mesh';
import { findProfile } from '../steel/profiles';
import { curvedBandBetween, curvedWallExtent } from './geometry/curvedWallGeometry';
import { stairBlocks, stairFlights } from './geometry/stairGeometry';
import {
  connectionBoltsSeed,
  connectionPartSeed,
  distinctPoints,
  landingSeed,
  openingVoidSeed,
  partSeed,
  pipeBendSeed,
  pipeSegmentSeed,
  plateBoltsSeed,
  slabVoidSeed,
} from './exchange/ifcSeeds';
import type { BuildingModel } from './types';

type Element = BuildingModel['elements'][string];

/** Categories exported as one product seeded by the element id, whenever the element's level is exported. */

/** True when some consecutive pair of `points` (scaled to mm) has a sweep frame, i.e. `sweptSolids` writes a solid. */
const sweeps = (points: ReadonlyArray<readonly [number, number, number]>, factor: number): boolean =>
  points.some((start, index) => {
    const end = points[index + 1];
    if (end === undefined) return false;
    return (
      sweepFrame([start[0] * factor, start[1] * factor, start[2] * factor], [end[0] * factor, end[1] * factor, end[2] * factor]) !== null
    );
  });

function pipeSeeds(element: Extract<Element, { category: 'pipe' }>, schema: IfcSchemaName, factor: number): string[] {
  const points = distinctPoints(element.points);
  if (points.length < 2) return [];
  if (schema === 'IFC4') return sweeps(element.points, factor) ? [element.id] : [];
  return points.flatMap((_, k) => {
    if (k === points.length - 1) return [];
    return k === points.length - 2 ? [pipeSegmentSeed(element.id, k)] : [pipeSegmentSeed(element.id, k), pipeBendSeed(element.id, k + 1)];
  });
}

function connectionSeeds(doc: CadDocument, building: BuildingModel, element: Extract<Element, { category: 'connection' }>): string[] {
  const solids = buildingConnectionSolids(doc, building, element) ?? [];
  const parts = solids.filter((solid) => !solid.part.startsWith('bolt')).map((solid) => connectionPartSeed(element.id, solid.part));
  return solids.some((solid) => solid.part.startsWith('bolt')) ? [...parts, connectionBoltsSeed(element.id)] : parts;
}

function wallHosted(building: BuildingModel, hostId: string): boolean {
  const host = building.elements[hostId];
  if (host?.category === 'wall') return true;
  if (host?.category !== 'curvedWall') return false;
  const extent = curvedWallExtent(building, host);
  return curvedBandBetween(host, extent.start, extent.end) !== null;
}

function ladderSeeds(doc: CadDocument, element: Extract<Element, { category: 'ladder' }>): string[] {
  if ([STILE_PROFILE, RUNG_PROFILE, HOOP_PROFILE, CAGE_BAR_PROFILE].some((name) => findProfile(name) === undefined)) return [];
  const { layout } = ladderQuantities(doc, element);
  const factor = toMm(doc, 1);
  const framed = (run: { from: readonly [number, number, number]; to: readonly [number, number, number] }, roll: number): boolean =>
    sweepFrame(
      [run.from[0] * factor, run.from[1] * factor, run.from[2] * factor],
      [run.to[0] * factor, run.to[1] * factor, run.to[2] * factor],
      roll,
    ) !== null;
  return [
    element.id,
    ...layout.stiles.flatMap((run, index) => (framed(run, -element.facing) ? [partSeed(element.id, 'stile', index + 1)] : [])),
    ...layout.rungs.flatMap((run, index) => (framed(run, 0) ? [partSeed(element.id, 'rung', index + 1)] : [])),
    ...layout.landings.map((_, index) => partSeed(element.id, 'landing', index + 1)),
  ];
}

function steelStairSeeds(doc: CadDocument, element: Extract<Element, { category: 'steelStair' }>): string[] {
  if (findProfile(element.stringerProfile) === undefined || !(treadThickness(doc, element.tread) > 0)) return [];
  const { layout } = stairQuantities(doc, element);
  const factor = toMm(doc, 1);
  const stringers = [...layout.stringers, ...layout.knuckles].flatMap((run, index) =>
    sweepFrame(
      [run.from[0] * factor, run.from[1] * factor, run.from[2] * factor],
      [run.to[0] * factor, run.to[1] * factor, run.to[2] * factor],
      0,
    ) === null
      ? []
      : [partSeed(element.id, 'stringer', index + 1)],
  );
  return [
    element.id,
    ...stringers,
    ...layout.flights.map((_, index) => partSeed(element.id, 'flight', index + 1)),
    ...layout.landings.map((_, index) => partSeed(element.id, 'landing', index + 1)),
  ];
}

function radialStairSeeds(doc: CadDocument, element: Extract<Element, { category: 'radialStair' }>): string[] {
  if (findProfile(element.profile) === undefined || !(treadThickness(doc, element.tread) > 0)) return [];
  const factor = toMm(doc, 1);
  const sections = element.runs.flatMap((run, index) =>
    sweepFrame(
      [run.from[0] * factor, run.from[1] * factor, run.from[2] * factor],
      [run.to[0] * factor, run.to[1] * factor, run.to[2] * factor],
      0,
    ) === null
      ? []
      : [partSeed(element.id, 'section', index + 1)],
  );
  return [element.id, ...sections, partSeed(element.id, 'flight', 1)];
}

function buildingStairSeeds(element: Extract<Element, { category: 'stair' }>): string[] {
  const flights = stairFlights(element);
  if (flights.length === 1) return [element.id];
  const landing = stairBlocks(element).some((block) => block.flight === null);
  return [
    element.id,
    ...flights.map((_, index) => partSeed(element.id, 'flight', index + 1)),
    ...(landing ? [landingSeed(element.id)] : []),
  ];
}

function railingSeeds(doc: CadDocument, element: Extract<Element, { category: 'railing' }>): string[] {
  const quantities = railingQuantities(doc, element);
  if (findProfile(element.postProfile) === undefined || findProfile(element.railProfile) === undefined || quantities === null) return [];
  return [element.id, ...quantities.layout.posts.map((_, index) => partSeed(element.id, 'post', index + 1))];
}

function plateSeeds(doc: CadDocument, building: BuildingModel, element: Extract<Element, { category: 'plate' }>): string[] {
  const member = building.elements[element.memberId];
  const level = building.levels[element.levelId];
  if (member?.category !== 'member' || level === undefined || plateLayout(doc, element, member, level) === null) return [];
  return [element.id, plateBoltsSeed(element.id)];
}

/**
 * Seeds of the products of `element` (see the file header). The element's level must be in `levelOrder`: `export_ifc` writes only those storeys.
 */
export function seedsOf(doc: CadDocument, building: BuildingModel, element: Element, schema: IfcSchemaName): string[] {
  if ('levelId' in element && (building.levels[element.levelId] === undefined || !building.levelOrder.includes(element.levelId))) return [];
  const factor = toMm(doc, 1);
  switch (element.category) {
    case 'wall':
    case 'column':
    case 'beam':
    case 'room':
    case 'equipment':
    case 'footing':
    case 'assembly':
      return [element.id];
    case 'grid':
      return [];
    case 'pipeSupport':
      return carrierOfSupport(doc, building, element) === undefined ? [] : [element.id];
    case 'door':
    case 'window':
      return wallHosted(building, element.hostId) ? [element.id, openingVoidSeed(element.id)] : [];
    case 'curvedWall': {
      const extent = curvedWallExtent(building, element);
      return curvedBandBetween(element, extent.start, extent.end) === null ? [] : [element.id];
    }
    case 'slab':
      return [element.id, ...(element.openings ?? []).map((_, index) => slabVoidSeed(element.id, index))];
    case 'stair':
      return buildingStairSeeds(element);
    case 'pipe':
      return pipeSeeds(element, schema, factor);
    case 'member':
      return findProfile(element.profile) !== undefined && sweepFrame(element.start, element.end, element.roll) !== null
        ? [element.id]
        : [];
    case 'panel':
      return panelFrame(
        element.corners.map((corner): [number, number, number] => [corner[0] * factor, corner[1] * factor, corner[2] * factor]),
      )
        ? [element.id]
        : [];
    case 'tray':
      return sweeps(element.points, factor) ? [element.id] : [];
    case 'connection':
      return connectionSeeds(doc, building, element);
    case 'plate':
      return plateSeeds(doc, building, element);
    case 'grating':
      return findGratingType(element.gratingType) === undefined ? [] : [element.id];
    case 'railing':
      return railingSeeds(doc, element);
    case 'ladder':
      return ladderSeeds(doc, element);
    case 'steelStair':
      return steelStairSeeds(doc, element);
    case 'radialStair':
      return radialStairSeeds(doc, element);
    default:
      return noSeeds(element);
  }
}

/** A category of a hand-edited file that no case names: no products. The `never` parameter makes a new category without a case a type error. */
const noSeeds = (_element: never): string[] => [];
