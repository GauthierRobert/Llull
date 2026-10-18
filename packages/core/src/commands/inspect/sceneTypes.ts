import type { AnimationChannel, AnimationMode, DimensionEntity, EntityKind, Vec3 } from '../../model/types';
import type { Bounds } from '../../geometry/bounds';

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  layerId: string;
  position: Vec3;
  /** World-space AABB. `oriented:true` when rotation was applied. */
  bounds: Bounds;
}

export interface LayerSummary {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Number of entities currently assigned to this layer. */
  entityCount: number;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberIds: string[];
}

export interface AnimationSummary {
  id: string;
  targetId: string;
  targetKind: 'entity' | 'group';
  channel: AnimationChannel;
  mode: AnimationMode;
}

/** A dimension with what it measures, so an agent reads values it cannot see in the geometry. */
export interface DimensionSummary {
  id: string;
  dimensionKind: DimensionEntity['dimensionKind'];
  entityIds: string[];
  /** Measured length/radius/diameter (document units) or angle (degrees); null when a reference is missing or degenerate. */
  value: number | null;
  /** 'deg' for angular, else the document unit. */
  unit: string;
  /** The text the drawing shows (label, or formatted value + tolerance); null when `value` is null. */
  text: string | null;
}

/** A text annotation. */
export interface TextSummary {
  id: string;
  content: string;
  position: Vec3;
  height: number;
}

/** Structured, AI-readable snapshot of the whole document. */
export interface SceneSnapshot {
  entityCount: number;
  entities: EntitySummary[];
  layers: LayerSummary[];
  groups: GroupSummary[];
  /** Combined bounds of all entities, or null when the document is empty. */
  bounds: Bounds | null;
  selection: string[];
  /** All declared animation clips in the document. */
  animations: AnimationSummary[];
  /** Every dimension entity with its measured value. */
  dimensions: DimensionSummary[];
  /** Every text entity. */
  texts: TextSummary[];
}
