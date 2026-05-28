/**
 * @layer core/mcp
 *
 * Entity-level delta types and pure patch/apply functions for incremental SSE sync.
 *
 * Shared between the server (patch computation) and the browser hook (patch application).
 * Pure — no fetch, no DOM, no server-only imports.
 *
 * Instead of broadcasting the full CadDocument after every command, the server
 * computes a minimal `DocPatch` and emits it over SSE.  The browser applies the
 * patch in O(change) time; only the changed entities are reconciled by React.
 *
 * Delta shape — tailored to CadDocument fields; not generic JSON-patch.
 */

import type {
  CadDocument,
  Entity,
  Layer,
  EntityGroup,
  Parameter,
  Animation,
  Configuration,
  Material,
  Recipe,
  Component,
  CameraState,
  DocumentUnit,
  FeatureStep,
  EntityId,
  Joint,
  DriveRelation,
} from '../model/types';

// ---------------------------------------------------------------------------
// Patch type
// ---------------------------------------------------------------------------

export interface EntityDelta {
  /** Entities added (id → full entity). */
  added: Record<string, Entity>;
  /** Entities whose value changed (id → full new entity). */
  changed: Record<string, Entity>;
  /** Ids of entities that were deleted. */
  removed: string[];
}

/**
 * Minimal description of what changed between two CadDocuments.
 *
 * Fields are only present when the corresponding part of the document changed.
 * An empty patch (all fields absent / empty delta) means the command was a no-op.
 */
export interface DocPatch {
  entities: EntityDelta;
  /** Full order array — present only when it changed. */
  order?: string[];
  /** Full selection array — present only when it changed. */
  selection?: string[];
  /**
   * Incremental feature history update — only the NEWLY APPENDED steps.
   * Since featureHistory is append-only for normal commands, we emit only the delta
   * so the patch stays O(1) in history length.
   * When present, the browser appends these steps to the existing history.
   * When `featureHistoryReplaced` is true, this contains the FULL new history
   * (used by undo/redo/replay where steps are removed or reordered).
   */
  featureHistoryAppended?: FeatureStep[];
  /**
   * When true, `featureHistoryAppended` holds the FULL replacement history.
   * The browser discards its current history and replaces it entirely.
   * Used for undo/redo which are broadcast as snapshots (not patches),
   * and for `featureHistoryReplaced` on reorder/suppress commands.
   */
  featureHistoryReplaced?: boolean;
  /** Full layers map — present only when any layer changed. */
  layers?: Record<string, Layer>;
  /** Full layerOrder array — present only when it changed. */
  layerOrder?: string[];
  /** Full groups map — present only when any group changed. */
  groups?: Record<string, EntityGroup>;
  /** Full parameters map — present only when any parameter changed. */
  parameters?: Record<string, Parameter>;
  /** Full animations map — present only when any animation changed. */
  animations?: Record<string, Animation>;
  /** Full configurations map — present only when any configuration changed. */
  configurations?: Record<string, Configuration>;
  /** Full materials map — present only when any material changed. */
  materials?: Record<string, Material>;
  /** Full recipes map — present only when any recipe changed. */
  recipes?: Record<string, Recipe>;
  /** Full components map — present only when any component changed. */
  components?: Record<string, Component>;
  /** Camera state — present only when it changed. */
  camera?: CameraState;
  /** Document units — present only when it changed. */
  units?: DocumentUnit;
  /** Display precision — present only when it changed. */
  displayPrecision?: number;
  /** Full constraints map — present only when any constraint changed. */
  constraints?: Record<string, unknown>;
  /** Full constraintOrder array — present only when it changed. */
  constraintOrder?: string[];
  /** Full joints map — present only when any joint changed. */
  joints?: Record<string, Joint>;
  /** Full jointOrder array — present only when it changed. */
  jointOrder?: string[];
  /** Full driveRelations map — present only when any drive relation changed. */
  driveRelations?: Record<string, DriveRelation>;
  /** Full driveRelationOrder array — present only when it changed. */
  driveRelationOrder?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable JSON comparison for small objects. Falls back to stringify for deep equality. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// computeDocPatch
// ---------------------------------------------------------------------------

/**
 * Compute the minimal DocPatch between two CadDocuments.
 *
 * Both parameters are treated as immutable (architecture L3 — commands are pure).
 * Returns a patch that, when applied to `prev`, produces the observable equivalent
 * of `next`.
 *
 * @pure — reads both docs, constructs the patch object, mutates nothing.
 */
export function computeDocPatch(prev: CadDocument, next: CadDocument): DocPatch {
  // --- entities ---
  const added: Record<string, Entity> = {};
  const changed: Record<string, Entity> = {};
  const removed: string[] = [];

  const prevIds = new Set<EntityId>(Object.keys(prev.entities));
  const nextIds = new Set<EntityId>(Object.keys(next.entities));

  for (const id of nextIds) {
    if (!prevIds.has(id)) {
      const entity = next.entities[id];
      if (entity !== undefined) added[id] = entity;
    } else {
      const prevEntity = prev.entities[id];
      const nextEntity = next.entities[id];
      if (!jsonEqual(prevEntity, nextEntity) && nextEntity !== undefined) {
        changed[id] = nextEntity;
      }
    }
  }

  for (const id of prevIds) {
    if (!nextIds.has(id)) {
      removed.push(id);
    }
  }

  const patch: DocPatch = {
    entities: { added, changed, removed },
  };

  if (!jsonEqual(prev.order, next.order))         patch.order = next.order;
  if (!jsonEqual(prev.selection, next.selection)) patch.selection = next.selection;

  // featureHistory — incremental: emit only the newly-appended steps so the patch
  // is O(appended steps) not O(total history length).
  // If the next history is strictly an extension of prev (same prefix), emit only the tail.
  // Otherwise (reorder, suppress, full replace) emit the full new history with the
  // `featureHistoryReplaced` flag so the browser does a full replace.
  if (!jsonEqual(prev.featureHistory, next.featureHistory)) {
    const prevLen = prev.featureHistory.length;
    const nextLen = next.featureHistory.length;
    if (
      nextLen >= prevLen &&
      jsonEqual(prev.featureHistory, next.featureHistory.slice(0, prevLen))
    ) {
      // Pure append — only emit new steps.
      patch.featureHistoryAppended = next.featureHistory.slice(prevLen);
    } else {
      // Structural change (suppress/reorder/replay) — full replacement.
      patch.featureHistoryAppended = next.featureHistory;
      patch.featureHistoryReplaced = true;
    }
  }

  if (!jsonEqual(prev.layers, next.layers))                 patch.layers = next.layers;
  if (!jsonEqual(prev.layerOrder, next.layerOrder))         patch.layerOrder = next.layerOrder;
  if (!jsonEqual(prev.groups, next.groups))                 patch.groups = next.groups;
  if (!jsonEqual(prev.parameters, next.parameters))         patch.parameters = next.parameters;
  if (!jsonEqual(prev.animations, next.animations))         patch.animations = next.animations;
  if (!jsonEqual(prev.configurations, next.configurations)) patch.configurations = next.configurations;
  if (!jsonEqual(prev.materials, next.materials))           patch.materials = next.materials;
  if (!jsonEqual(prev.recipes, next.recipes))               patch.recipes = next.recipes;
  if (!jsonEqual(prev.components, next.components))         patch.components = next.components;
  if (!jsonEqual(prev.camera, next.camera))                 patch.camera = next.camera;
  if (prev.units !== next.units)                            patch.units = next.units;
  if (prev.displayPrecision !== next.displayPrecision)      patch.displayPrecision = next.displayPrecision;
  if (!jsonEqual(prev.constraints, next.constraints))       patch.constraints = next.constraints as Record<string, unknown>;
  if (!jsonEqual(prev.constraintOrder, next.constraintOrder)) patch.constraintOrder = next.constraintOrder;
  if (!jsonEqual(prev.joints, next.joints))                 patch.joints = next.joints;
  if (!jsonEqual(prev.jointOrder, next.jointOrder))         patch.jointOrder = next.jointOrder;
  if (!jsonEqual(prev.driveRelations, next.driveRelations)) patch.driveRelations = next.driveRelations;
  if (!jsonEqual(prev.driveRelationOrder, next.driveRelationOrder)) patch.driveRelationOrder = next.driveRelationOrder;

  return patch;
}

// ---------------------------------------------------------------------------
// applyDocPatch
// ---------------------------------------------------------------------------

/**
 * Apply a DocPatch to a CadDocument, producing a new document.
 *
 * Called by the browser hook to update the Zustand store document without
 * touching unchanged entities — only the patched entities cause React to
 * reconcile and re-render.
 *
 * @pure — returns a new document; never mutates `doc` or `patch`.
 * @param doc   - the current document to patch.
 * @param patch - the delta emitted by the server.
 * @returns     a new CadDocument with the patch applied.
 */
export function applyDocPatch(doc: CadDocument, patch: DocPatch): CadDocument {
  const { added, changed, removed } = patch.entities;

  const hasEntityChange =
    Object.keys(added).length > 0 ||
    Object.keys(changed).length > 0 ||
    removed.length > 0;

  let entities = doc.entities;
  if (hasEntityChange) {
    entities = { ...doc.entities };
    for (const [id, entity] of Object.entries(added))   entities[id] = entity;
    for (const [id, entity] of Object.entries(changed)) entities[id] = entity;
    for (const id of removed)                           delete entities[id];
  }

  // featureHistory: append new steps or full-replace depending on the patch flag.
  let featureHistory = doc.featureHistory;
  if (patch.featureHistoryAppended !== undefined) {
    featureHistory = patch.featureHistoryReplaced
      ? patch.featureHistoryAppended
      : [...doc.featureHistory, ...patch.featureHistoryAppended];
  }

  return {
    entities,
    order:            patch.order            ?? doc.order,
    selection:        patch.selection        ?? doc.selection,
    featureHistory,
    layers:           patch.layers           ?? doc.layers,
    layerOrder:       patch.layerOrder       ?? doc.layerOrder,
    groups:           patch.groups           ?? doc.groups,
    parameters:       patch.parameters       ?? doc.parameters,
    animations:       patch.animations       ?? doc.animations,
    configurations:   patch.configurations   ?? doc.configurations,
    materials:        patch.materials        ?? doc.materials,
    recipes:          patch.recipes          ?? doc.recipes,
    components:       patch.components       ?? doc.components,
    camera:           patch.camera           ?? doc.camera,
    units:            patch.units            ?? doc.units,
    displayPrecision: patch.displayPrecision ?? doc.displayPrecision,
    constraints:        (patch.constraints as typeof doc.constraints | undefined) ?? doc.constraints,
    constraintOrder:    patch.constraintOrder  ?? doc.constraintOrder,
    joints:             patch.joints           ?? doc.joints,
    jointOrder:         patch.jointOrder       ?? doc.jointOrder,
    driveRelations:     patch.driveRelations   ?? doc.driveRelations,
    driveRelationOrder: patch.driveRelationOrder ?? doc.driveRelationOrder,
  };
}
