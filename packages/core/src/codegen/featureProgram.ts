/**
 * Lower a CadDocument to a FeatureProgram (program.ts): replay the feature history, diff each step's solids, and bind numeric fields to the
 * `=expr` params that produced them.
 */

import { type CadDocument, type Entity, type FeatureStep, type Vec3, is2D, is3D } from '../model/types';
import { subdivide } from '../geometry/subdivision';
import { settleLevels } from '../geometry/subd/settle';
import { isCurve3D, isSheet } from '../model/curveKinds';
import type { CommandDefinition } from '../commands/types';
import { replayHistory, type ReplayStepEvent } from '../commands/history/replay';
import { buildParamEnv } from '../commands/history/regenerate';
import { evaluateExpression, extractReferences } from '../commands/parametric/expression';
import { entityTrianglePositions } from '../geometry/entityTriangles';
import { expandInstance } from '../geometry/instanceExpansion';
import { Namer, translateExpression } from './identifiers';
import type { GeometryKernel } from '../geometry/kernel';
import { recipeOf } from '../geometry/shapeRecipe';
import { blendNotExpressible, lowerRecipe, meshSoup, modificationFeature } from './recipeLowering';
import { embossNodes } from '../geometry/embossRecipe';
import { skinShape, withRefusalNotes } from './skinLowering';
import { tracedCall } from './paramTree';
import type {
  Axis,
  Feature,
  FeatureBase,
  FeatureProgram,
  ProgramOutput,
  ProgramParameter,
  ShapeSpec,
  Term,
  Term2,
  Term3,
  TracedCall,
} from './program';

const EPSILON = 1e-9;

interface LowerContext {
  readonly identifiers: ReadonlyMap<string, string>;
  readonly env: Readonly<Record<string, number>>;
  /** Queried for exact edge mid points and fillet result triangles; null = indices only. */
  readonly kernel: GeometryKernel | null;
  /** False for targets that cannot rebuild a variable / two-leg chamfer (FreeCAD): exported as the exact result's triangles. */
  readonly chamferLegs: boolean;
}

/** Bind `value` to the raw `=expr` param when (and only when) the expression evaluates to it. */
function term(value: number, raw: unknown, ctx: LowerContext): Term {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return { value };
  const evaluated = evaluateExpression(raw.slice(1), ctx.env);
  if (!evaluated.ok) return { value };
  if (Math.abs(evaluated.value - value) > EPSILON * Math.max(1, Math.abs(value))) return { value };
  const expression = translateExpression(raw.slice(1), ctx.identifiers);
  return expression === null ? { value } : { value, expression };
}

function child(raw: unknown, key: string | number): unknown {
  if (raw === null || typeof raw !== 'object') return undefined;
  return (raw as Record<string | number, unknown>)[key];
}

function term3(values: Vec3, raw: unknown, ctx: LowerContext): Term3 {
  return [term(values[0], child(raw, 0), ctx), term(values[1], child(raw, 1), ctx), term(values[2], child(raw, 2), ctx)];
}

function profileTerms(profile: ReadonlyArray<readonly [number, number]>, raw: unknown, ctx: LowerContext): Term2[] {
  return profile.map(([x, y], i) => {
    const rawPoint = child(raw, i);
    return [term(x, child(rawPoint, 0), ctx), term(y, child(rawPoint, 1), ctx)];
  });
}

function safeSegments(value: unknown): number {
  const segments = Math.trunc(Number(value));
  return Number.isFinite(segments) && segments >= 3 ? segments : 32;
}

function dominantAxis(axis: Vec3): Axis {
  const [ax, ay, az] = axis.map(Math.abs) as [number, number, number];
  if (az >= ax && az >= ay) return 'z';
  return ay >= ax ? 'y' : 'x';
}

/** Lower one evaluated entity to a shape; `raw` are the params of the step that produced it. */
function lowerShape(entity: Entity, doc: CadDocument, raw: unknown, ctx: LowerContext, trace: TracedCall | null): ShapeSpec {
  const field = (key: string): unknown => child(raw, key);
  if (is2D(entity) || isCurve3D(entity) || isSheet(entity)) return { kind: 'mesh', positions: entityTrianglePositions(entity, doc) };
  switch (entity.kind) {
    case 'box':
    case 'wedge':
      return { kind: entity.kind, size: term3(entity.size, field('size'), ctx) };
    case 'cylinder':
    case 'cone':
      return { kind: entity.kind, radius: term(entity.radius, field('radius'), ctx), height: term(entity.height, field('height'), ctx) };
    case 'sphere':
      return { kind: 'sphere', radius: term(entity.radius, field('radius'), ctx) };
    case 'torus':
      return {
        kind: 'torus',
        ringRadius: term(entity.ringRadius, field('ringRadius'), ctx),
        tubeRadius: term(entity.tubeRadius, field('tubeRadius'), ctx),
      };
    case 'pyramid':
      return {
        kind: 'pyramid',
        baseWidth: term(entity.baseWidth, field('baseWidth'), ctx),
        baseDepth: term(entity.baseDepth, field('baseDepth'), ctx),
        height: term(entity.height, field('height'), ctx),
      };
    case 'extrusion':
      return {
        kind: 'extrusion',
        profile: profileTerms(entity.profile, field('profile'), ctx),
        depth: term(entity.depth, field('depth'), ctx),
      };
    case 'revolution':
      return {
        kind: 'revolution',
        profile: profileTerms(entity.profile, field('profile'), ctx),
        axis: dominantAxis(entity.axis),
        angle: term(entity.angle, field('angle'), ctx),
        // Untrusted documents (load_document) reach code generation: force a safe integer.
        segments: safeSegments(entity.segments),
      };
    case 'subdivision': {
      // semi-sharp creases are not in the Python port: export the cage refined (with them) until they have decayed
      const settle = settleLevels(entity);
      const cage = settle === 0 ? entity : subdivide(entity, settle);
      return {
        kind: 'subdivision',
        vertices: cage.vertices,
        faces: cage.faces,
        creases: cage.creases,
        levels: Math.max(0, entity.levels - settle),
      };
    }
    case 'sweep':
    case 'loft':
      return skinShape(entity, doc, trace);
    case 'mesh':
    case 'instance':
      return { kind: 'mesh', positions: entityTrianglePositions(entity, doc) };
  }
}

function solidFeature(
  entity: Entity,
  doc: CadDocument,
  raw: unknown,
  ctx: LowerContext,
  base: FeatureBase,
  trace: TracedCall | null = null,
): Extract<Feature, { op: 'solid' }> {
  const shape = lowerShape(entity, doc, raw, ctx, trace);
  const isMesh = shape.kind === 'mesh';
  return {
    ...base,
    op: 'solid',
    shape,
    // Mesh triangles are already world-space (placement folded in).
    position: isMesh ? zero3() : term3(entity.position, child(raw, 'position'), ctx),
    rotation: isMesh ? zero3() : term3(entity.rotation, child(raw, 'rotation'), ctx),
    color: entity.color,
  };
}

/**
 * Features creating `entity` in `variables`: a kernel result rebuilds its exact recipe; anything else (or a recipe with a rotated placement
 * / scale) is one solid feature.
 * @returns the features and whether the entity was exported as a triangle mesh
 */
function entityFeatures(
  entity: Entity,
  doc: CadDocument,
  raw: unknown,
  ctx: LowerContext,
  namer: Namer,
  base: (variable: string) => FeatureBase,
  variables: Map<string, string>,
  trace: TracedCall | null = null,
): { features: Feature[]; triangles: boolean } {
  if (entity.kind === 'instance') {
    const component = doc.components[entity.componentId];
    const children = component === undefined ? [] : expandInstance(entity, component).filter(is3D);
    if (children.length > 0) {
      const lowered = children.map((expanded) => entityFeatures(expanded, doc, undefined, ctx, namer, base, variables));
      const names = children.flatMap((expanded) => variablesOf(variables, expanded.id));
      names.forEach((name, k) => variables.set(`${entity.id}#${k}`, name));
      return { features: lowered.flatMap((item) => item.features), triangles: lowered.some((item) => item.triangles) };
    }
  }
  if (entity.kind === 'mesh' && entity.brep !== undefined) {
    const lowered = lowerRecipe(recipeOf(entity), {
      kernel: ctx.kernel,
      take: (preferred) => namer.take(preferred),
      solid: (leaf, variable) => solidFeature(leaf, doc, undefined, ctx, base(variable)),
      base,
      chamferLegs: ctx.chamferLegs,
    });
    if (lowered !== null) {
      variables.set(entity.id, lowered.variable);
      const label: Feature[] = entity.name !== undefined ? [{ ...base(lowered.variable), op: 'label', name: entity.name }] : [];
      return { features: [...lowered.features, ...label], triangles: false };
    }
  }
  const variable = namer.take(preferredVariable(entity));
  variables.set(entity.id, variable);
  return {
    features: [solidFeature(entity, doc, raw, ctx, base(variable), trace)],
    triangles: entity.kind === 'mesh' || entity.kind === 'instance',
  };
}

/** The note for a solid exported as triangles; a blend the program cannot express names BLD_CODEGEN_UNSUPPORTED (the export carries the exact result, never a different fillet). */
function meshNote(subject: string, entity: Entity): string {
  if (entity.kind === 'mesh' && entity.brep !== undefined && embossNodes(recipeOf(entity)).length > 0)
    return `WRP_CODEGEN_UNSUPPORTED: ${subject} has an emboss, deboss, scribe or split on a face (03 WRP) that no generated code expresses; exported as the exact result's triangle mesh (export_step through the native kernel, without the Python bridge, keeps the exact faces).`;
  const blend = entity.kind === 'mesh' && entity.brep !== undefined && blendNotExpressible(entity.brep);
  return blend
    ? `BLD_CODEGEN_UNSUPPORTED: ${subject} has a blend (a chamfer with an angle, or a variable / two-distance chamfer on a curved edge, a non-planar face or several edges with two distances, which only the CadQuery and build123d exports rebuild on straight edges between planes, not edges that share a corner, and not FreeCAD; a conic / curvature profile or a two-leg fillet) no generated code expresses; exported as the exact result's triangle mesh.`
    : `${subject} has no analytic form; exported as a triangle mesh.`;
}

function zero3(): Term3 {
  return [{ value: 0 }, { value: 0 }, { value: 0 }];
}

/** Non-geometric entity fields: a change limited to these is metadata, not a new feature. */
const METADATA_FIELDS = new Set(['name', 'tags', 'layerId', 'materialId', 'color', 'patternSourceId']);

/** Deep equality with a numeric tolerance (replayed floats may differ in the last bits). */
function nearlyEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number')
    return Math.abs(left - right) <= EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, i) => nearlyEqual(item, right[i]));
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => nearlyEqual(a[key], b[key]));
  }
  return left === right;
}

/** Same shape and placement, ignoring id and metadata (name, colour, layer, tags, material). */
function geometryEqual(a: Entity, b: Entity): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'id' || METADATA_FIELDS.has(key)) continue;
    const left = (a as unknown as Record<string, unknown>)[key];
    const right = (b as unknown as Record<string, unknown>)[key];
    if (!nearlyEqual(left, right)) return false;
  }
  return true;
}

function isPureTranslation(before: Entity, after: Entity, delta: unknown): delta is Vec3 {
  if (!Array.isArray(delta) || delta.length !== 3) return false;
  if (!delta.every((d) => typeof d === 'number' && Number.isFinite(d))) return false;
  const moved = { ...before, position: after.position } as Entity;
  if (!geometryEqual(moved, after)) return false;
  return after.position.every((p, i) => Math.abs(p - (before.position[i] as number) - (delta[i] as number)) <= EPSILON);
}

/** `boolean` op -> the emitted program's combinator. */
const BOOLEAN_KINDS: Readonly<Record<string, 'union' | 'cut' | 'intersect'>> = { union: 'union', subtract: 'cut', intersect: 'intersect' };

function lowerParameters(doc: CadDocument, namer: Namer): { parameters: ProgramParameter[]; identifiers: Map<string, string> } {
  const identifiers = new Map<string, string>();
  for (const name of Object.keys(doc.parameters)) identifiers.set(name, namer.take(name));
  // Depth-first topological order so each parameter is defined after the ones it references.
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) !== undefined) return;
    state.set(name, 'visiting');
    const parameter = doc.parameters[name];
    if (parameter && parameter.error === undefined) {
      for (const ref of extractReferences(parameter.expression)) {
        if (ref in doc.parameters) visit(ref);
      }
    }
    state.set(name, 'done');
    ordered.push(name);
  };
  for (const name of Object.keys(doc.parameters).sort()) visit(name);
  const parameters = ordered.flatMap((name): ProgramParameter[] => {
    const parameter = doc.parameters[name];
    const identifier = identifiers.get(name);
    if (parameter === undefined || identifier === undefined) return [];
    const literal = Number(parameter.expression);
    if (parameter.error !== undefined || Number.isFinite(literal)) return [{ name, identifier, value: parameter.value }];
    const expression = translateExpression(parameter.expression, identifiers);
    return [expression === null ? { name, identifier, value: parameter.value } : { name, identifier, value: parameter.value, expression }];
  });
  return { parameters, identifiers };
}

/** 3D entities in document order. */
function solids(doc: CadDocument): Entity[] {
  return doc.order.flatMap((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity) ? [entity] : [];
  });
}

function preferredVariable(entity: Entity): string {
  return entity.name !== undefined && entity.name.trim() !== '' ? entity.name : entity.kind;
}

/** Every program variable of an entity: one per solid of an expanded instance, else the single variable. */
function variablesOf(variables: ReadonlyMap<string, string>, id: string): string[] {
  const group: string[] = [];
  for (let k = 0; variables.has(`${id}#${k}`); k++) group.push(variables.get(`${id}#${k}`) ?? '');
  const single = variables.get(id);
  return group.length > 0 ? group : single === undefined ? [] : [single];
}

function outputsFor(doc: CadDocument, variables: ReadonlyMap<string, string>): ProgramOutput[] {
  return solids(doc).flatMap((entity): ProgramOutput[] =>
    variablesOf(variables, entity.id).map((variable, k, all): ProgramOutput => {
      const name = entity.name !== undefined && all.length > 1 ? `${entity.name} ${k + 1}` : entity.name;
      return name !== undefined ? { variable, color: entity.color, name } : { variable, color: entity.color };
    }),
  );
}

function lowerSnapshot(doc: CadDocument, parameters: ProgramParameter[], ctx: LowerContext, namer: Namer, notes: string[]): FeatureProgram {
  const variables = new Map<string, string>();
  const features: Feature[] = [];
  for (const entity of solids(doc)) {
    const base = (variable: string): FeatureBase => ({ step: null, command: entity.kind, variable });
    const lowered = entityFeatures(entity, doc, undefined, ctx, namer, base, variables);
    const [first, ...rest] = lowered.features;
    const named =
      lowered.features.length === 1 && first?.op === 'solid' && entity.name !== undefined
        ? [{ ...first, name: entity.name }]
        : [first, ...rest].filter((feature): feature is Feature => feature !== undefined);
    features.push(...named);
    if (lowered.triangles) notes.push(meshNote(`${entity.kind} '${entity.id}'`, entity));
  }
  return { units: doc.units, source: 'snapshot', parameters, features, outputs: outputsFor(doc, variables), notes };
}

const MODIFICATION_COMMANDS: ReadonlySet<string> = new Set(['fillet_edge', 'chamfer_edge', 'shell_solid']);

/** A fillet / chamfer / shell step that replaced one solid by its exact modification, in place. */
function modificationStep(
  event: ReplayStepEvent,
  created: readonly Entity[],
  removed: readonly string[],
  variables: Map<string, string>,
  ctx: LowerContext,
  base: (variable: string) => FeatureBase,
): Feature | null {
  const [result] = created;
  const sourceId = String(child(event.params, 'id'));
  const variable = variables.get(sourceId);
  if (!MODIFICATION_COMMANDS.has(event.step.name) || created.length !== 1 || removed.length !== 1) return null;
  if (removed[0] !== sourceId || variable === undefined || result?.kind !== 'mesh') return null;
  const brep = result.brep;
  if (brep === undefined || (brep.op !== 'fillet' && brep.op !== 'chamfer' && brep.op !== 'shell')) return null;
  if (brep.op === 'shell' && brep.openNear !== undefined && brep.openNear.length > 0) return null;
  const sizeParam = { fillet: 'radius', chamfer: 'distance', shell: 'thickness' }[brep.op];
  const value = brep.op === 'shell' ? brep.thickness : brep.size;
  const size = term(value, child(event.rawParams, sizeParam), ctx);
  const feature = modificationFeature(brep, base(variable), ctx.kernel, meshSoup(result.mesh), size, ctx.chamferLegs);
  if (feature === null) return null;
  variables.delete(sourceId);
  variables.set(result.id, variable);
  return feature;
}

/** The sweep_profile / loft_sections call a step recorded, when the solid it created can be rebuilt from those params alone. */
function stepTrace(event: ReplayStepEvent, created: readonly Entity[], ctx: LowerContext): TracedCall | null {
  const command = event.step.name;
  if ((command !== 'sweep_profile' && command !== 'loft_sections') || created.length !== 1) return null;
  const kind = created[0]?.kind;
  if (kind !== (command === 'sweep_profile' ? 'sweep' : 'loft')) return null;
  return tracedCall(command, event.params, event.rawParams, (value, raw) => term(value, raw, ctx));
}

/** Lower one replayed step into features, keeping `variables` (entity id → variable) current. */
function lowerStep(
  event: ReplayStepEvent,
  stepNumber: number,
  variables: Map<string, string>,
  ctx: LowerContext,
  namer: Namer,
  notes: string[],
): Feature[] {
  const { before, after, step, rawParams } = event;
  const beforeIds = new Set(solids(before).map((e) => e.id));
  const afterSolids = solids(after);
  const created = afterSolids.filter((e) => !beforeIds.has(e.id));
  const removed = [...beforeIds].filter((id) => after.entities[id] === undefined);
  const changed = afterSolids.flatMap((current): Array<[Entity, Entity]> => {
    const previous = before.entities[current.id];
    return previous !== undefined && previous !== current ? [[previous, current]] : [];
  });
  const [createdSolid] = created;
  const base = (variable: string): FeatureBase => ({ step: stepNumber, command: step.name, variable });
  const booleanKind = step.name === 'boolean' ? BOOLEAN_KINDS[String(child(event.params, 'op'))] : undefined;
  const operandA = String(child(event.params, 'a'));
  const rawB = child(event.params, 'b');
  const operandsB = (Array.isArray(rawB) ? rawB : [rawB]).map(String);
  const left = variables.get(operandA);
  const rights = operandsB.map((operand) => variables.get(operand));
  if (
    booleanKind !== undefined &&
    createdSolid !== undefined &&
    created.length === 1 &&
    removed.length === 1 + operandsB.length &&
    changed.length === 0 &&
    left !== undefined &&
    rights.every((right) => right !== undefined)
  ) {
    for (const operand of operandsB) variables.delete(operand);
    variables.delete(operandA);
    variables.set(createdSolid.id, left);
    return rights.map((right) => ({ ...base(left), op: 'boolean' as const, kind: booleanKind, left, right: right as string }));
  }
  const modification = modificationStep(event, created, removed, variables, ctx, base);
  if (modification !== null) return [modification];
  const features: Feature[] = [];
  for (const id of removed) {
    const group = variablesOf(variables, id);
    for (const variable of group) features.push({ ...base(variable), op: 'remove' });
    variables.delete(id);
    group.forEach((_, k) => variables.delete(`${id}#${k}`));
  }
  for (const [previous, current] of changed) {
    const group = variablesOf(variables, current.id);
    const variable = group[0];
    if (variable === undefined) continue;
    const delta = child(event.params, 'delta');
    if (step.name === 'move_entities' && isPureTranslation(previous, current, delta))
      for (const member of group) features.push({ ...base(member), op: 'translate', delta: term3(delta, child(rawParams, 'delta'), ctx) });
    else if (geometryEqual(previous, current)) {
      if (current.name !== undefined && current.name !== previous.name && group.length === 1)
        features.push({ ...base(variable), op: 'label', name: current.name });
    } else {
      // Re-create from the evaluated state; remove first so the old solid does not linger.
      for (const member of group) features.push({ ...base(member), op: 'remove' });
      if ((current.kind === 'mesh' && current.brep !== undefined) || current.kind === 'instance') {
        // A kernel result edited in place (set_thread, ...) or an instance: rebuild its recipe(s) so feature notes (thread, drill point) survive.
        const lowered = entityFeatures(current, after, rawParams, ctx, namer, base, variables);
        features.push(...lowered.features);
        if (lowered.triangles) notes.push(meshNote(`step ${stepNumber} (${step.name}): ${current.kind} '${current.id}'`, current));
      } else features.push(solidFeature(current, after, rawParams, ctx, base(variable)));
    }
  }
  for (const entity of created) {
    const lowered = entityFeatures(entity, after, rawParams, ctx, namer, base, variables, stepTrace(event, created, ctx));
    features.push(...lowered.features);
    if (lowered.triangles) notes.push(meshNote(`step ${stepNumber} (${step.name}): ${entity.kind} '${entity.id}'`, entity));
  }
  return features;
}

/** Why the replayed history does not reproduce `doc`'s solids (count or geometry), or null. */
function historyMismatch(doc: CadDocument, replayed: CadDocument): string | null {
  const expected = solids(doc);
  const actual = solids(replayed);
  if (expected.length !== actual.length)
    return `featureHistory replays to ${actual.length} solid(s) but the document has ${expected.length}`;
  const differing = expected.find((original, i) => {
    const regenerated = actual[i];
    return regenerated === undefined || !geometryEqual(original, regenerated);
  });
  return differing === undefined ? null : `featureHistory regenerates solid '${differing.id}' with different geometry`;
}

/** Curves and surface sheets have no solid to rebuild: say so instead of dropping them silently. */
function skippedSurfaceNote(doc: CadDocument): string[] {
  const skipped = doc.order.filter((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && (isCurve3D(entity) || isSheet(entity));
  });
  return skipped.length === 0 ? [] : [`not exported to code (curves and surface sheets have no solid form): ${skipped.join(', ')}.`];
}

/** The note of a program that exports a straight radius law: OCP has no exact one, so the fillet call carries graded nodes (`lawNodes`). */
const STRAIGHT_LAW_NOTE =
  'straight radius law exported as a graded-node spline (OCP has no exact straight law), within 1e-8 relative of the exact volume (adaptive reading, measured 3e-10); the native kernel and its STEP carry the exact law.';

/** The note of a program that exports a monotone radius law: OCP interpolates the dense nodes of the exact curve with its own cubic. */
const MONOTONE_LAW_NOTE =
  'monotone radius law exported as 12 nodes per piece on the exact curve, interpolated by the own cubic spline of OCP: within 2e-6 relative of the exact volume and 2e-3 of the radius (measured, 06 BLD 13.23); the native kernel and its STEP carry the exact law.';

function withStraightLawNote(program: FeatureProgram): FeatureProgram {
  const laws = program.features.flatMap((feature) => (feature.op === 'fillet' ? (feature.laws ?? []) : []));
  const notes = [
    ...(laws.some((law) => law.linear) ? [STRAIGHT_LAW_NOTE] : []),
    ...(laws.some((law) => law.monotone === true) ? [MONOTONE_LAW_NOTE] : []),
  ];
  return notes.length === 0 ? program : { ...program, notes: [...program.notes, ...notes] };
}

function buildProgram(
  doc: CadDocument,
  getCommand: (name: string) => CommandDefinition<unknown> | undefined,
  kernel: GeometryKernel | null = null,
  chamferLegs = true,
): FeatureProgram {
  const namer = new Namer();
  const { parameters, identifiers } = lowerParameters(doc, namer);
  const ctx: LowerContext = { identifiers, env: buildParamEnv(doc.parameters), kernel, chamferLegs };
  const notes: string[] = skippedSurfaceNote(doc);
  const activeSteps: FeatureStep[] = doc.featureHistory.filter((s) => s.suppressed !== true);
  if (activeSteps.length === 0) return lowerSnapshot(doc, parameters, ctx, namer, notes);
  const features: Feature[] = [];
  const variables = new Map<string, string>();
  const stepNumbers = new Map(doc.featureHistory.map((s, i) => [s.id, i + 1]));
  const replayed = replayHistory(doc, doc.featureHistory, getCommand, undefined, (event) => {
    const stepNumber = stepNumbers.get(event.step.id) ?? 0;
    features.push(...lowerStep(event, stepNumber, variables, ctx, namer, notes));
  });
  const mismatch = historyMismatch(doc, replayed);
  if (mismatch !== null) {
    notes.push(`${mismatch}; exported the current geometry without its feature history.`);
    const freshNamer = new Namer();
    for (const parameter of parameters) freshNamer.take(parameter.identifier);
    return lowerSnapshot(doc, parameters, ctx, freshNamer, notes);
  }
  return { units: doc.units, source: 'history', parameters, features, outputs: outputsFor(replayed, variables), notes };
}

/**
 * Lower a document to a FeatureProgram. Prefers the featureHistory (parametric, ordered); falls
 * back to the current geometry when there is no history or replay does not reproduce the document.
 * @invariant replay draws entity ids from the global `nextId` counter (as replay_history does), so
 *   ids minted after an export differ from ids minted without one; no document content changes.
 * @invariant chamferLegs=false (FreeCAD) exports a variable / two-leg chamfer as the exact result's triangles with BLD_CODEGEN_UNSUPPORTED
 * @invariant history is used only when it regenerates every solid of `doc` (count + geometry).
 */
export function buildFeatureProgram(
  doc: CadDocument,
  getCommand: (name: string) => CommandDefinition<unknown> | undefined,
  kernel: GeometryKernel | null = null,
  chamferLegs = true,
): FeatureProgram {
  return withRefusalNotes(withStraightLawNote(buildProgram(doc, getCommand, kernel, chamferLegs)));
}
