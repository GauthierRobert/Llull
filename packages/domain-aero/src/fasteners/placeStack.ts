/**
 * Placement of one fastener stack (08 MAT FR-MAT-15): cuts the hole through every layer (kernel boolean via `execute('boolean')`), creates
 * the standard-part components once per part number, inserts the bolt / washer / nut instances and records the stack. Runs inside the
 * caller's feature step, so ids are step-scoped and one undo reverts everything.
 */

import { type CadDocument, type Component, type Entity, type CylinderEntity, DEFAULT_LAYER_ID, type Vec3 } from '@core/model/types';
import type { FastenerStack } from '@core/model/fasteners';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { eulerFromAxis } from '@lib/axisRotation';
import { add3, scale3 } from '@lib/vec3';
import { nextId } from '@lib/id';
import { fastenerModel, withFasteners } from './fastenerDoc';
import { type PartBuild, componentIdOf, fastenerBody, nutBody, washerBody } from './partGeometry';
import { type MeasuredStack, type Resolved } from './selection';
import { inchesToDoc, quantityToDoc } from './units';

export type HoleMode = 'cut_close_tolerance' | 'cut_clearance' | 'none';

export type PlaceFailure = { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[] };

export interface Placed {
  readonly ok: true;
  readonly document: CadDocument;
  readonly stack: FastenerStack;
  /** Entity ids created or replaced: instances first (bolt, washers, nut), then the cut plates. */
  readonly affected: readonly string[];
  /** Plate id before the cut -> the id of the plate with the hole. */
  readonly replaced: Readonly<Record<string, string>>;
  readonly representative: readonly string[];
}

const fail = (code: string, message: string, ids: readonly string[] = []): PlaceFailure => ({ ok: false, code, message, ids });

/** Hole diameter in document units: the caller's, else the catalogue's close-tolerance / clearance value. */
export function holeDiameterDoc(
  doc: CadDocument,
  resolved: Resolved,
  mode: HoleMode,
  given: { readonly value: number; readonly unit: string } | undefined,
): number | PlaceFailure {
  if (mode === 'none') return 0;
  if (given !== undefined) {
    const converted = quantityToDoc(doc, given.value, given.unit);
    return converted !== null && converted > 0
      ? converted
      : fail('FAST_HOLE_DIAMETER_UNKNOWN', `holeDiameter ${given.value} ${given.unit} is not a positive length`);
  }
  const catalogue = mode === 'cut_close_tolerance' ? resolved.size.holeDiameter : undefined;
  if (catalogue !== undefined) return quantityToDoc(doc, (catalogue.min + catalogue.max) / 2, catalogue.unit) ?? 0;
  const clearance = resolved.size.dims['clearanceHoleDiameter'];
  const value = clearance?.nominal ?? clearance?.max;
  if (mode === 'cut_clearance' && clearance !== undefined && value !== undefined) return quantityToDoc(doc, value, clearance.unit) ?? 0;
  return fail(
    'FAST_HOLE_DIAMETER_UNKNOWN',
    `size '${resolved.size.dash}' of ${resolved.family.id} lists no ${mode === 'cut_close_tolerance' ? 'close-tolerance' : 'clearance'} hole diameter`,
    [resolved.family.id],
  );
}

function holeTool(measured: MeasuredStack, diameter: number): CylinderEntity {
  const height = measured.endS - measured.startS + 2 * diameter;
  const center = add3(measured.origin, scale3(measured.direction, (measured.startS + measured.endS) / 2));
  return {
    id: nextId('cyl'),
    kind: 'cylinder',
    position: center,
    rotation: eulerFromAxis(measured.direction) ?? [0, 0, 0],
    radius: diameter / 2,
    height,
    layerId: DEFAULT_LAYER_ID,
    color: '#ff00ff',
  };
}

/** Re-point every recorded stack layer from a replaced plate to its successor. */
function remapLayers(doc: CadDocument, oldId: string, newId: string): CadDocument {
  const stacks = fastenerModel(doc).stacks;
  const touched = Object.values(stacks).filter((stack) => stack.layers.some((layer) => layer.entityId === oldId));
  if (touched.length === 0) return doc;
  const next = { ...stacks };
  for (const stack of touched)
    next[stack.id] = { ...stack, layers: stack.layers.map((layer) => (layer.entityId === oldId ? { ...layer, entityId: newId } : layer)) };
  return withFasteners(doc, { stacks: next });
}

type Cut = { readonly document: CadDocument; readonly replaced: Record<string, string>; readonly cutIds: string[] } | PlaceFailure;

function cutHoles(doc: CadDocument, ctx: ExecutionContext | undefined, measured: MeasuredStack, diameter: number): Cut {
  let current = doc;
  const replaced: Record<string, string> = {};
  for (const layer of measured.layers) {
    const plate = current.entities[layer.entityId];
    if (plate === undefined) return fail('FAST_LAYER_MISSING', `layer '${layer.entityId}' disappeared`, [layer.entityId]);
    const tool = holeTool(measured, diameter);
    const withTool: CadDocument = { ...current, entities: { ...current.entities, [tool.id]: tool }, order: [...current.order, tool.id] };
    const cut = execute(withTool, 'boolean', { op: 'subtract', a: layer.entityId, b: tool.id }, ctx);
    const newId = cut.affected[0];
    const created = newId === undefined ? undefined : cut.document.entities[newId];
    if (newId === undefined || created === undefined || cut.document === withTool)
      return fail('FAST_HOLE_CUT_FAILED', `kernel boolean on '${layer.entityId}' failed: ${cut.summary}`, [layer.entityId]);
    const carried: Entity = {
      ...created,
      ...(plate.materialId === undefined ? {} : { materialId: plate.materialId }),
      ...(plate.name === undefined ? {} : { name: plate.name }),
      ...(plate.tags === undefined ? {} : { tags: plate.tags }),
    };
    current = remapLayers({ ...cut.document, entities: { ...cut.document.entities, [newId]: carried } }, layer.entityId, newId);
    replaced[layer.entityId] = newId;
  }
  return { document: current, replaced, cutIds: Object.values(replaced) };
}

/** Adds the part component when absent. The builder always runs, so ids minted in the step do not depend on components replay carried over. */
function withComponent(doc: CadDocument, partNumber: string, build: () => PartBuild): { document: CadDocument; build: PartBuild | null } {
  const id = componentIdOf(partNumber);
  const made = build();
  if (Object.hasOwn(doc.components, id)) return { document: doc, build: null };
  const components: Record<string, Component> = { ...doc.components, [id]: made.component };
  return { document: { ...doc, components }, build: made };
}

/**
 * Cut the hole, create the part components and instances and record the stack.
 * @failure no measured axis (stack given as a number) -> FAST_STACK_MISSING; hole diameter unknown -> FAST_HOLE_DIAMETER_UNKNOWN; kernel boolean fails -> FAST_HOLE_CUT_FAILED
 */
export function placeStack(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  resolved: Resolved,
  mode: HoleMode,
  diameter: number,
  rowId?: string,
): Placed | PlaceFailure {
  const measured = resolved.measured;
  if (measured === null)
    return fail('FAST_STACK_MISSING', 'placing a stack needs stackIds with axisPoint (the axis), not a bare stack thickness');
  const stackId = nextId('fst');
  let current = doc;
  let replaced: Record<string, string> = {};
  let cutIds: string[] = [];
  if (mode !== 'none') {
    const cut = cutHoles(current, ctx, measured, diameter);
    if ('ok' in cut) return cut;
    current = cut.document;
    replaced = cut.replaced;
    cutIds = cut.cutIds;
  }
  const representative: string[] = [];
  const own = (partNumber: string, build: () => PartBuild): void => {
    const added = withComponent(current, partNumber, build);
    current = added.document;
    if (added.build?.representative === true) representative.push(partNumber);
    else if (added.build === null && current.components[componentIdOf(partNumber)]?.partRef?.representative === true)
      representative.push(partNumber);
  };
  own(resolved.partNumber, () => fastenerBody(current, resolved));
  for (const washer of resolved.washers)
    own(washer.partNumber, () => washerBody(current, resolved.family, resolved.size, washer.partNumber, washer.thicknessIn));
  const nut = resolved.nut;
  if (nut !== null) own(nut.partNumber, () => nutBody(current, nut.family, nut.size, nut.partNumber));

  const rotation = eulerFromAxis(measured.direction) ?? [0, 0, 0];
  const at = (s: number): Vec3 => add3(measured.origin, scale3(measured.direction, s));
  const place = (partNumber: string, s: number): string | null => {
    const placed = execute(current, 'insert_instance', { componentId: componentIdOf(partNumber), position: at(s), rotation }, ctx);
    const id = placed.affected[0];
    if (id === undefined) return null;
    current = placed.document;
    return id;
  };
  const washerThickness = resolved.washers.map((washer) => inchesToDoc(doc, washer.thicknessIn));
  const total = washerThickness.reduce((sum, value) => sum + value, 0);
  const headWashers = resolved.washerSide === 'head';
  const washerStart = headWashers ? measured.startS - total : measured.endS;
  const boltId = place(resolved.partNumber, headWashers ? washerStart : measured.startS);
  let cursor = washerStart;
  const washerRecords: FastenerStack['washers'][number][] = [];
  const instanceIds: string[] = boltId === null ? [] : [boltId];
  for (const [index, washer] of resolved.washers.entries()) {
    const id = place(washer.partNumber, cursor);
    if (id !== null) {
      washerRecords.push({ partNumber: washer.partNumber, instanceId: id, side: resolved.washerSide });
      instanceIds.push(id);
    }
    cursor += washerThickness[index] ?? 0;
  }
  const nutId = nut === null ? null : place(nut.partNumber, headWashers ? measured.endS : cursor);
  if (boltId === null || (nut !== null && nutId === null)) return fail('FAST_HOLE_CUT_FAILED', 'inserting a fastener instance failed');
  if (nutId !== null) instanceIds.push(nutId);

  const stack: FastenerStack = {
    id: stackId,
    axis: { origin: measured.origin, direction: measured.direction },
    layers: measured.layers.map((layer) => ({
      entityId: replaced[layer.entityId] ?? layer.entityId,
      thickness: inchesToDoc(doc, layer.thicknessIn),
    })),
    fastener: { family: resolved.family.id, partNumber: resolved.partNumber, instanceId: boltId, diameterDash: resolved.size.dash },
    washers: washerRecords,
    ...(nut === null || nutId === null ? {} : { nut: { partNumber: nut.partNumber, instanceId: nutId } }),
    stackThickness: measured.endS - measured.startS,
    holeMode: mode,
    holeDiameter: diameter,
    ...(rowId === undefined ? {} : { rowId }),
  };
  const document = withFasteners(current, { stacks: { ...fastenerModel(current).stacks, [stackId]: stack } });
  return { ok: true, document, stack, affected: [...instanceIds, ...cutIds], replaced, representative };
}
