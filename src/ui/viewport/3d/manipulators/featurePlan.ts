// What a feature drag session asks of the command layer: the dry-run call that feeds the ghost, and the call that commits it.
// Pure. It only names existing commands and their params (extrude_profile / fillet_edge / shell_solid, boolean) - the UI never builds
// an entity (L4). A join / cut extrusion commits as ONE build_project (extrude, then boolean), so a single Undo reverts it.

import { type Bounds, boundsExtent, entityBoundsInDoc } from '@core/geometry/bounds';
import type { CadDocument, Entity, EntityId } from '@core/model/types';
import { applyEulerXYZ } from '@lib/eulerRotation';
import {
  type BooleanMode,
  type ModeChoice,
  type Vec3,
  findBodyInReach,
  resolveExtrudeMode,
  stepForScale,
  sweptBounds,
} from './manipulatorMath';

export type FeatureKind = 'extrude' | 'fillet' | 'shell';

export interface FeatureSession {
  kind: FeatureKind;
  targetId: EntityId;
  /** Extrude: signed distance along the profile normal (negative = inward). Fillet radius / shell thickness: positive. */
  value: number;
  modeChoice: ModeChoice;
}

interface CommandCall {
  name: string;
  params: Record<string, unknown>;
}

export interface FeaturePlan {
  /** Dry run feeding the ghost. */
  preview: CommandCall;
  /** Dispatched once on release / Enter. */
  commit: CommandCall;
  /** Cut draws the ghost in the warning tone. */
  tone: 'add' | 'cut';
  /** Extrusions only: how the result combines with `bodyId`. */
  mode: BooleanMode | null;
  bodyId: EntityId | null;
}

/** Where the handle sits and which way it drags: `origin` + `axis` * value is the grip position. */
export interface HandleFrame {
  origin: Vec3;
  axis: Vec3;
  /** Characteristic model size; sizes the grip and sets the drag step. */
  scale: number;
}

const UP: Vec3 = [0, 0, 1];
const DOWN: Vec3 = [0, 0, -1];

/** Normal of a sketch's work plane: its local +Z, which extrude_profile follows (a flat sketch gives UP). */
const sketchNormal = (entity: Entity): Vec3 => applyEulerXYZ(UP, [0, 0, 0], entity.rotation);

const KIND_COMMAND: Record<FeatureKind, string> = { extrude: 'extrude_profile', fillet: 'fillet_edge', shell: 'shell_solid' };
const KIND_VALUE_PARAM = { fillet: 'radius', shell: 'thickness' } as const;

/** Smallest meaningful value; below it there is nothing to preview. */
const MIN_VALUE = 1e-6;

export function featureStep(frame: HandleFrame): number {
  return stepForScale(frame.scale);
}

/** @pure */
export function handleFrame(doc: CadDocument, kind: FeatureKind, targetId: EntityId): HandleFrame | null {
  const entity = doc.entities[targetId];
  if (entity === undefined) return null;
  const box: Bounds = entityBoundsInDoc(doc, entity);
  const scale = Math.max(boundsExtent(box), 1e-3);
  const centreX = (box.min[0] + box.max[0]) / 2;
  const centreY = (box.min[1] + box.max[1]) / 2;
  switch (kind) {
    case 'extrude':
      return { origin: [centreX, centreY, (box.min[2] + box.max[2]) / 2], axis: sketchNormal(entity), scale };
    case 'fillet':
      return { origin: [box.max[0], centreY, box.max[2]], axis: [-1, 0, 0], scale };
    case 'shell':
      return { origin: [centreX, centreY, box.max[2]], axis: DOWN, scale };
  }
}

/** Starting value of a fresh session: a quarter / twentieth / twenty-fifth of the part, snapped to the drag step. @pure */
export function initialValue(kind: FeatureKind, frame: HandleFrame): number {
  const fraction = kind === 'extrude' ? 0.25 : kind === 'fillet' ? 0.05 : 0.04;
  const step = stepForScale(frame.scale);
  return Math.max(step, Math.round((frame.scale * fraction) / step) * step);
}

/** Smallest value the handle may take: extrusions are signed, fillet / shell stay positive. */
export function minimumValue(kind: FeatureKind): number {
  return kind === 'extrude' ? -Infinity : MIN_VALUE;
}

function extrudePlan(doc: CadDocument, session: FeatureSession): FeaturePlan | null {
  const profile = doc.entities[session.targetId];
  if (profile === undefined || Math.abs(session.value) < MIN_VALUE) return null;
  const normal = sketchNormal(profile);
  const axis: Vec3 = session.value < 0 ? [0 - normal[0], 0 - normal[1], 0 - normal[2]] : normal;
  const params = { id: session.targetId, depth: Math.abs(session.value), axis };
  const extrude: CommandCall = { name: KIND_COMMAND.extrude, params };
  const swept = sweptBounds(entityBoundsInDoc(doc, profile), session.value);
  const bodyId = findBodyInReach(doc, swept, (id) => entityBoundsInDoc(doc, doc.entities[id] ?? profile), new Set([session.targetId]));
  const mode = resolveExtrudeMode(session.modeChoice, session.value, bodyId !== undefined);
  if (mode === 'new' || bodyId === undefined) return { preview: extrude, commit: extrude, tone: 'add', mode, bodyId: bodyId ?? null };
  const boolean = { op: mode === 'cut' ? 'subtract' : 'union', a: bodyId, b: '$tool' };
  const commit: CommandCall = {
    name: 'build_project',
    params: {
      actions: [
        { command: extrude.name, params, as: 'tool' },
        { command: 'boolean', params: boolean },
      ],
      onError: 'abort',
    },
  };
  return { preview: extrude, commit, tone: mode === 'cut' ? 'cut' : 'add', mode, bodyId };
}

/** @pure */
export function planForSession(doc: CadDocument, session: FeatureSession): FeaturePlan | null {
  if (session.kind === 'extrude') return extrudePlan(doc, session);
  if (!(session.value >= MIN_VALUE) || doc.entities[session.targetId] === undefined) return null;
  const call: CommandCall = {
    name: KIND_COMMAND[session.kind],
    params: { id: session.targetId, [KIND_VALUE_PARAM[session.kind]]: session.value },
  };
  return { preview: call, commit: call, tone: 'add', mode: null, bodyId: null };
}
