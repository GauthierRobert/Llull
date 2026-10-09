/**
 * Civil / site-engineering model (survey, terrain, earthworks, roads, drainage): the constructive
 * definition the civil plugin evaluates into ordinary entities. Lengths and elevations are in
 * document units; slopes are ratios (horizontal per 1 vertical for side slopes).
 *
 * @layer core/model
 */

import type { Vec2, Vec3 } from './types';

export const CIVIL_CATEGORIES = [
  'pointGroup',
  'surface',
  'platform',
  'alignment',
  'manhole',
  'pipe',
] as const;

export type CivilCategory = (typeof CIVIL_CATEGORIES)[number];

interface CivilObjectBase {
  readonly id: string;
  readonly category: CivilCategory;
  readonly name: string;
  /** Entities evaluated from this object (`<id>:<part>`); rewritten by every regeneration. */
  readonly entityIds: readonly string[];
}

export interface SurveyPoint {
  /** Point number / name from the survey file, e.g. "1001". */
  readonly number: string;
  /** Easting, northing, elevation. */
  readonly position: Vec3;
  /** Field code, e.g. "TOPO", "EP" (edge of pavement), "TREE". */
  readonly code?: string;
}

export interface PointGroupObject extends CivilObjectBase {
  readonly category: 'pointGroup';
  readonly points: readonly SurveyPoint[];
}

/** Existing-ground TIN built from point groups (+ loose points), clipped to an optional boundary. */
export interface SurfaceObject extends CivilObjectBase {
  readonly category: 'surface';
  readonly pointGroupIds: readonly string[];
  readonly extraPoints: readonly Vec3[];
  /** Outer boundary in plan; triangles whose centroid lies outside are dropped. */
  readonly boundary?: readonly Vec2[];
  /** Triangles with a longer plan edge are dropped (concave hulls). */
  readonly maxEdgeLength?: number;
  /** Minor contour interval (document units). */
  readonly contourInterval: number;
  /** Every n-th contour is a major (labelled) contour. */
  readonly majorEvery: number;
}

/** Flat building pad / platform graded into a surface with cut and fill side slopes. */
export interface PlatformObject extends CivilObjectBase {
  readonly category: 'platform';
  readonly surfaceId: string;
  /** Closed pad outline in plan (counter-clockwise). */
  readonly boundary: readonly Vec2[];
  readonly elevation: number;
  /** Cut batter, horizontal per 1 vertical (e.g. 1.5 for 1.5H:1V). */
  readonly cutSlope: number;
  /** Fill batter, horizontal per 1 vertical. */
  readonly fillSlope: number;
}

/** Vertical point of intersection of the design profile. */
export interface ProfilePvi {
  readonly station: number;
  readonly elevation: number;
  /** Symmetric parabolic vertical curve length centred on the PVI (0 = grade break). */
  readonly curveLength: number;
}

/** Symmetric road template applied along an alignment. */
export interface RoadSection {
  /** Carriageway width each side of the centreline. */
  readonly laneWidth: number;
  /** Paved / unpaved shoulder width each side. */
  readonly shoulderWidth: number;
  /** Crossfall from the centreline, positive = falls away (e.g. 0.025 = 2.5 %). */
  readonly crossfall: number;
  /** Cut batter, horizontal per 1 vertical. */
  readonly cutSlope: number;
  /** Fill batter, horizontal per 1 vertical. */
  readonly fillSlope: number;
}

/** Road / channel centreline: tangents through PIs with circular curves, profile and template. */
export interface AlignmentObject extends CivilObjectBase {
  readonly category: 'alignment';
  /** Points of intersection in plan (start, interior PIs, end). */
  readonly points: readonly Vec2[];
  /** Circular curve radius per interior PI (0 = no curve). Length = points.length - 2. */
  readonly radii: readonly number[];
  readonly startStation: number;
  /** Station tick / cross-section interval (document units). */
  readonly stationInterval: number;
  /** Existing-ground surface sampled for the long section and earthworks. */
  readonly surfaceId?: string;
  /** Design profile (sorted by station); empty = none. */
  readonly profile: readonly ProfilePvi[];
  readonly section?: RoadSection;
}

/** Drainage structure (manhole / inspection chamber / outfall). */
export interface ManholeObject extends CivilObjectBase {
  readonly category: 'manhole';
  readonly position: Vec2;
  readonly rimElevation: number;
  readonly invertElevation: number;
  /** Chamber internal diameter. */
  readonly diameter: number;
  /** Contributing catchment (rational method), when any. */
  readonly catchment?: {
    /** Catchment area in hectares. */
    readonly areaHa: number;
    /** Runoff coefficient C (0–1). */
    readonly runoffCoefficient: number;
  };
  /** Additional point inflow (litres per second), e.g. foul flow. */
  readonly inflow?: number;
}

/** Gravity pipe between two structures (flow from `fromId` to `toId`). */
export interface PipeObject extends CivilObjectBase {
  readonly category: 'pipe';
  readonly fromId: string;
  readonly toId: string;
  /** Internal diameter. */
  readonly diameter: number;
  readonly material: string;
  /** Manning roughness n. */
  readonly manningN: number;
  readonly invertFrom: number;
  readonly invertTo: number;
}

export type CivilObject =
  | PointGroupObject
  | SurfaceObject
  | PlatformObject
  | AlignmentObject
  | ManholeObject
  | PipeObject;

export interface CivilModel {
  readonly objects: Readonly<Record<string, CivilObject>>;
  /** Creation / evaluation order. */
  readonly order: readonly string[];
  /** Highest number issued per id prefix, so deleted ids are never reused. */
  readonly counters: Readonly<Record<string, number>>;
}

export function createEmptyCivil(): CivilModel {
  return { objects: {}, order: [], counters: {} };
}
