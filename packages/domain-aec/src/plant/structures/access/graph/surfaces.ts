/** Nodes of the access graph (06 STA §5.7): grade, floor slabs, loose grating panels and platform assemblies (all panels of one assembly are one node). */

import type { CadDocument, Vec2 } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { polygonArea } from '@lib/polygon';
import { elementsOf } from '@aec/building/model';
import type { AssemblyElement, BuildingModel, GratingElement, SlabElement } from '@aec/building/types';
import { findGratingType } from '../../grating/gratingTypes';
import { boxOf, makeRegion, unionBox, type Region, type Ring } from './regions';
import { GRADE_ID, type SurfaceNode } from './types';

const scaled = (ring: ReadonlyArray<Vec2>, factor: number): Ring => ring.map(([x, y]): Vec2 => [x * factor, y * factor]);

const areaM2 = (regions: ReadonlyArray<Region>): number =>
  regions.reduce(
    (sum, region) => sum + polygonArea([...region.outer]) - region.holes.reduce((s, hole) => s + polygonArea([...hole]), 0),
    0,
  ) / 1e6;

export const gradeNode = (gradeMm: number): SurfaceNode => ({
  id: GRADE_ID,
  kind: 'grade',
  members: [],
  levelId: null,
  mark: 'grade',
  topMm: gradeMm,
  thicknessMm: 0,
  regions: [],
  box: [-Infinity, -Infinity, Infinity, Infinity],
  areaM2: 0,
});

function slabNode(building: BuildingModel, slab: SlabElement, factor: number): SurfaceNode | null {
  const level = building.levels[slab.levelId];
  if (level === undefined || slab.role !== 'floor') return null;
  const region = makeRegion(
    scaled(slab.boundary, factor),
    (slab.openings ?? []).map((hole) => scaled(hole, factor)),
  );
  return {
    id: slab.id,
    kind: 'slab',
    members: [slab.id],
    levelId: slab.levelId,
    mark: slab.mark,
    topMm: (level.elevation + slab.offset) * factor,
    thicknessMm: slab.thickness * factor,
    regions: [region],
    box: region.box,
    areaM2: areaM2([region]),
  };
}

const gratingTop = (building: BuildingModel, panel: GratingElement, factor: number): number | null => {
  const level = building.levels[panel.levelId];
  return level === undefined ? null : (level.elevation + panel.topOffset) * factor;
};

/** Every walkable surface of the building, `grade` excluded: slabs with role floor, loose panels, one node per platform assembly. Skips elements whose level is missing. */
export function surfaceNodes(doc: CadDocument, building: BuildingModel): SurfaceNode[] {
  const factor = MM_PER_UNIT[doc.units];
  const nodes: SurfaceNode[] = [];
  for (const slab of elementsOf(building, 'slab')) {
    const node = slabNode(building, slab, factor);
    if (node !== null) nodes.push(node);
  }
  const panelsOf = new Map<string, GratingElement[]>();
  for (const panel of elementsOf(building, 'grating')) {
    const owner = panel.assemblyId === undefined ? undefined : building.elements[panel.assemblyId];
    if (owner?.category === 'assembly' && (owner.kind === 'platform' || owner.kind === 'circular_platform')) {
      panelsOf.set(owner.id, [...(panelsOf.get(owner.id) ?? []), panel]);
      continue;
    }
    const top = gratingTop(building, panel, factor);
    if (top === null) continue;
    const region = makeRegion(scaled(panel.boundary, factor));
    nodes.push({
      id: panel.id,
      kind: 'grating',
      members: [panel.id],
      levelId: panel.levelId,
      mark: panel.mark,
      topMm: top,
      thicknessMm: findGratingType(panel.gratingType)?.barDepthMm ?? 0,
      regions: [region],
      box: region.box,
      areaM2: areaM2([region]),
    });
  }
  for (const assembly of elementsOf(building, 'assembly')) {
    const node = platformNode(building, assembly, panelsOf.get(assembly.id) ?? [], factor);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

function platformNode(
  building: BuildingModel,
  assembly: AssemblyElement,
  panels: readonly GratingElement[],
  factor: number,
): SurfaceNode | null {
  if ((assembly.kind !== 'platform' && assembly.kind !== 'circular_platform') || panels.length === 0) return null;
  const tops = panels.flatMap((panel) => gratingTop(building, panel, factor) ?? []);
  if (tops.length === 0) return null;
  const regions = panels.map((panel) => makeRegion(scaled(panel.boundary, factor)));
  return {
    id: assembly.id,
    kind: assembly.kind,
    members: panels.map((panel) => panel.id),
    levelId: assembly.levelId,
    mark: assembly.mark,
    topMm: Math.max(...tops),
    thicknessMm: Math.max(...panels.map((panel) => findGratingType(panel.gratingType)?.barDepthMm ?? 0)),
    regions,
    box: unionBox(regions.map((region) => boxOf(region.outer))),
    areaM2: areaM2(regions),
  };
}
