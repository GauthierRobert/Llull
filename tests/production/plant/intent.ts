import type { Vec2, Vec3 } from '@core/model/types';
import type { MemberRole } from '@core/model/building';

/**
 * @layer tests/production/plant
 *
 * Design intent of a process-plant structure job, in absolute millimetres. One intent feeds the
 * agent brief (`brief.ts`), the scripted tool calls (`script.ts`) and the acceptance criteria
 * (`criteria/*.ts`), so the three can never disagree.
 */

export interface IntentLevel {
  name: string;
  /** Finished-floor level (FFL). */
  elevation: number;
  height: number;
}

export interface IntentMember {
  role: MemberRole;
  profile: string;
  /** Absolute axis end points (section centroid line). */
  start: Vec3;
  end: Vec3;
  /** Index into `levels` of the storey the member belongs to. */
  level: number;
  /** Section roll about the axis (radians); columns: π/2 puts the strong axis along Y. */
  roll?: number;
  /** Beam end joints: 'rigid' = moment connection to the member it frames into. */
  startJoint?: 'pinned' | 'rigid';
  endJoint?: 'pinned' | 'rigid';
  /** Column base fixity. */
  baseFixity?: 'pinned' | 'fixed';
}

export interface IntentFloor {
  level: number;
  boundary: Vec2[];
  thickness: number;
  material: string;
}

export interface IntentEquipment {
  tag: string;
  name: string;
  level: number;
  location: Vec2;
  /** [length along X, width along Y, height]. */
  size: Vec3;
  /** Operating weight, kg. */
  weight: number;
  clearance: number;
}

/** A pipe end is an equipment tag or a battery-limit tie-in id. */
export interface IntentPipe {
  line: string;
  service: string;
  dn: number;
  from: string;
  to: string;
  /** Absolute centreline route. */
  route: Vec3[];
}

/** A cable tray run: absolute centreline route (z = tray centre). */
export interface IntentTray {
  system: string;
  width: number;
  /** Side height of the U section. */
  height: number;
  route: Vec3[];
}

export interface IntentStair {
  /** Index of the level the flight starts from; it climbs to the next level. */
  level: number;
  start: Vec2;
  angle: number;
  width: number;
}

export interface PlantIntent {
  project: {
    name: string;
    client: string;
    author: string;
    drawingNumber: string;
    revision: string;
    date: string;
  };
  levels: IntentLevel[];
  grid: { xSpacings: number[]; ySpacings: number[] };
  members: IntentMember[];
  floors: IntentFloor[];
  equipment: IntentEquipment[];
  pipes: IntentPipe[];
  /** Battery-limit points where a line may end open (tie-in to another unit). */
  tieIns: Record<string, Vec3>;
  stairs: IntentStair[];
  /** Cable trays (absent on jobs without any). */
  trays?: IntentTray[];
  /**
   * Structure rules in the brief's own words, replacing the multi-storey building rules that
   * `plantBrief` derives from the members (used by structures that are not a floored building).
   */
  structureBrief?: string[];
}

/** Grid axis coordinates from spacings: numbered axes along X, lettered axes along Y. */
export function gridCoordinates(spacings: number[]): number[] {
  const coordinates = [0];
  for (const spacing of spacings) coordinates.push((coordinates.at(-1) ?? 0) + spacing);
  return coordinates;
}

/** Lettered axis labels (I and O skipped, as on drawings and in add_grid_system). */
export function letterLabels(count: number): string[] {
  return 'ABCDEFGHJKLMNPQRSTUVWXYZ'.slice(0, count).split('');
}

/** "level-<n>" ids are minted in creation order; the intent creates levels bottom-up. */
export function levelId(index: number): string {
  return `level-${index + 1}`;
}
