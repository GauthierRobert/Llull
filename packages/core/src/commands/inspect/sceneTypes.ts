import type { AnimationChannel, AnimationMode, EntityKind, Vec3 } from '../../model/types';
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
}
