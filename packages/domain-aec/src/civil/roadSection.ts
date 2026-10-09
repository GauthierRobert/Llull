/**
 * Road cross-section: the template (carriageway + shoulders with crossfall), the cut / fill batters
 * to daylight on an existing-ground TIN, and the cut / fill areas against that ground.
 * Lengths are document units; offsets are signed from the centreline (left of travel positive).
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';
import type { AlignmentObject, RoadSection } from '@core/model/civil';
import { elevationAt, type Tin } from './tin';
import { pointAtStation } from './alignmentGeometry';
import { crossSlopesAt, type CrossSlopes } from './superelevation';

export interface SectionNode {
  readonly offset: number;
  readonly z: number;
}

export interface RoadCrossSection {
  readonly station: number;
  readonly origin: Vec2;
  /** Travel direction (radians). */
  readonly direction: number;
  readonly designZ: number;
  /** Template nodes, ascending offset: right shoulder edge .. left shoulder edge (5 nodes). */
  readonly template: readonly SectionNode[];
  /** Daylight catch points (null when no ground or off the TIN). */
  readonly left: SectionNode | null;
  readonly right: SectionNode | null;
  /** Full design line (batters included), ascending offset. */
  readonly design: readonly SectionNode[];
}

export interface SectionAreas {
  readonly cutArea: number;
  readonly fillArea: number;
  readonly groundCentre: number | null;
}

/**
 * Template nodes for a centreline elevation, ascending offset. `slopes` overrides the normal crown
 * (superelevation): left of travel is positive offset.
 */
export function templateNodes(
  section: RoadSection,
  designZ: number,
  slopes: CrossSlopes = { left: section.crossfall, right: section.crossfall },
): SectionNode[] {
  const lane = section.laneWidth;
  const edge = lane + section.shoulderWidth;
  const at = (offset: number): SectionNode => ({
    offset,
    z: designZ - (offset >= 0 ? slopes.left : slopes.right) * Math.abs(offset),
  });
  return [at(-edge), at(-lane), at(0), at(lane), at(edge)];
}

const BATTER_STEP_METRES = 0.5;
const BATTER_REACH_METRES = 60;

interface Rule {
  readonly section: RoadSection;
  readonly step: number;
  readonly reach: number;
}

function findDaylight(
  tin: Tin,
  edge: Vec2,
  outward: Vec2,
  edgeZ: number,
  rule: Rule,
): number | null {
  const ground = (d: number): number | null =>
    elevationAt(tin, [edge[0] + outward[0] * d, edge[1] + outward[1] * d]);
  const ground0 = ground(0);
  if (ground0 === null) return null;
  const fill = ground0 < edgeZ;
  const batter = (d: number): number =>
    fill ? edgeZ - d / rule.section.fillSlope : edgeZ + d / rule.section.cutSlope;
  const gap = (d: number): number | null => {
    const g = ground(d);
    return g === null ? null : fill ? g - batter(d) : batter(d) - g;
  };
  if (ground0 === edgeZ) return 0;
  let previous = 0;
  for (let d = rule.step; d <= rule.reach; d += rule.step) {
    const value = gap(d);
    if (value === null) return null;
    if (value >= 0) {
      let low = previous;
      let high = d;
      for (let k = 0; k < 30; k++) {
        const mid = (low + high) / 2;
        if ((gap(mid) ?? 1) >= 0) high = mid;
        else low = mid;
      }
      return high;
    }
    previous = d;
  }
  return null;
}

/**
 * Cross-section at `station` for centreline elevation `designZ`. With a `tin`, adds the batters to
 * daylight on both sides (cut where the ground is above the shoulder edge, else fill).
 * `unitsPerMetre` converts the metre-based batter search step / reach into document units.
 */
export function crossSectionAt(
  alignment: AlignmentObject,
  section: RoadSection,
  tin: Tin | null,
  station: number,
  designZ: number,
  unitsPerMetre: number,
): RoadCrossSection | null {
  const placed = pointAtStation(alignment, station);
  if (!placed) return null;
  const slopes = crossSlopesAt(alignment, section.crossfall, section.laneWidth, station);
  const template = templateNodes(section, designZ, slopes);
  const normal: Vec2 = [-Math.sin(placed.direction), Math.cos(placed.direction)];
  const rule: Rule = {
    section,
    step: BATTER_STEP_METRES * unitsPerMetre,
    reach: BATTER_REACH_METRES * unitsPerMetre,
  };
  const side = (node: SectionNode, sign: 1 | -1): SectionNode | null => {
    if (!tin) return null;
    const edge: Vec2 = [
      placed.point[0] + normal[0] * node.offset,
      placed.point[1] + normal[1] * node.offset,
    ];
    const distance = findDaylight(tin, edge, [normal[0] * sign, normal[1] * sign], node.z, rule);
    if (distance === null) return null;
    const fill = (elevationAt(tin, edge) ?? node.z) < node.z;
    const dz = fill ? -distance / section.fillSlope : distance / section.cutSlope;
    return { offset: node.offset + sign * distance, z: node.z + dz };
  };
  const right = side(template[0] as SectionNode, -1);
  const left = side(template[template.length - 1] as SectionNode, 1);
  return {
    station,
    origin: placed.point,
    direction: placed.direction,
    designZ,
    template,
    left,
    right,
    design: [...(right ? [right] : []), ...template, ...(left ? [left] : [])],
  };
}

function designAtOffset(design: ReadonlyArray<SectionNode>, offset: number): number {
  for (let i = 1; i < design.length; i++) {
    const a = design[i - 1] as SectionNode;
    const b = design[i] as SectionNode;
    if (offset <= b.offset) {
      return b.offset === a.offset
        ? b.z
        : a.z + ((b.z - a.z) * (offset - a.offset)) / (b.offset - a.offset);
    }
  }
  return (design[design.length - 1] as SectionNode).z;
}

/** Ground elevation at one offset of a cross-section (null off the TIN). */
export function groundAtOffset(cross: RoadCrossSection, tin: Tin, offset: number): number | null {
  return elevationAt(tin, [
    cross.origin[0] - Math.sin(cross.direction) * offset,
    cross.origin[1] + Math.cos(cross.direction) * offset,
  ]);
}

/** Offsets where the section is sampled: every design node plus `step`-spaced fillers. */
export function sectionOffsets(cross: RoadCrossSection, step: number): number[] {
  const first = (cross.design[0] as SectionNode).offset;
  const last = (cross.design[cross.design.length - 1] as SectionNode).offset;
  const offsets = new Set<number>(cross.design.map((node) => node.offset));
  for (let o = first + step; o < last; o += step) offsets.add(o);
  return [...offsets].sort((a, b) => a - b);
}

/** Cut / fill areas (document units squared) between the design line and the ground. */
export function sectionAreas(cross: RoadCrossSection, tin: Tin, step: number): SectionAreas {
  const samples = sectionOffsets(cross, step).map((offset) => {
    const ground = groundAtOffset(cross, tin, offset);
    return { offset, diff: ground === null ? null : designAtOffset(cross.design, offset) - ground };
  });
  let cutArea = 0;
  let fillArea = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as { offset: number; diff: number | null };
    const b = samples[i] as { offset: number; diff: number | null };
    if (a.diff === null || b.diff === null) continue;
    const width = b.offset - a.offset;
    if (a.diff >= 0 && b.diff >= 0) fillArea += ((a.diff + b.diff) / 2) * width;
    else if (a.diff <= 0 && b.diff <= 0) cutArea += ((-a.diff - b.diff) / 2) * width;
    else {
      const crossing = (a.diff / (a.diff - b.diff)) * width;
      const first = (Math.abs(a.diff) * crossing) / 2;
      const second = (Math.abs(b.diff) * (width - crossing)) / 2;
      if (a.diff > 0) {
        fillArea += first;
        cutArea += second;
      } else {
        cutArea += first;
        fillArea += second;
      }
    }
  }
  return { cutArea, fillArea, groundCentre: groundAtOffset(cross, tin, 0) };
}
