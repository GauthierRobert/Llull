/**
 * Lower a CadDocument to a FeatureProgram (program.ts): replay the feature history, diff each step's
 * solids, and bind numeric fields to the `=expr` params that produced them.
 *
 * @layer core/codegen
 * @pure
 */

import type { CadDocument, Entity, FeatureStep, Vec3 } from '../model/types';
import { is3D } from '../model/types';
import type { CommandDefinition } from '../commands/types';
import { replayHistory, type ReplayStepEvent } from '../commands/replay';
import { buildParamEnv } from '../commands/regenerate';
import { evaluateExpression, extractReferences } from '../commands/expression';
import { entityToTriangles } from '../commands/exportTriangulate';
import { Namer, translateExpression } from './identifiers';
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
} from './program';

const EPSILON = 1e-9;

interface LowerContext {
  readonly identifiers: ReadonlyMap<string, string>;
  readonly env: Readonly<Record<string, number>>;
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
  return [
    term(values[0], child(raw, 0), ctx),
    term(values[1], child(raw, 1), ctx),
    term(values[2], child(raw, 2), ctx),
  ];
}

function profileTerms(
  profile: ReadonlyArray<readonly [number, number]>,
  raw: unknown,
  ctx: LowerContext,
): Term2[] {
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
function lowerShape(entity: Entity, doc: CadDocument, raw: unknown, ctx: LowerContext): ShapeSpec {
  const field = (key: string): unknown => child(raw, key);
  switch (entity.kind) {
    case 'box':
      return { kind: 'box', size: term3(entity.size, field('size'), ctx) };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radius: term(entity.radius, field('radius'), ctx),
        height: term(entity.height, field('height'), ctx),
      };
    case 'sphere':
      return { kind: 'sphere', radius: term(entity.radius, field('radius'), ctx) };
    case 'cone':
      return {
        kind: 'cone',
        radius: term(entity.radius, field('radius'), ctx),
        height: term(entity.height, field('height'), ctx),
      };
    case 'torus':
      return {
        kind: 'torus',
        ringRadius: term(entity.ringRadius, field('ringRadius'), ctx),
        tubeRadius: term(entity.tubeRadius, field('tubeRadius'), ctx),
      };
    case 'wedge':
      return { kind: 'wedge', size: term3(entity.size, field('size'), ctx) };
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
    default: {
      const positions: number[] = [];
      for (const triangle of entityToTriangles(entity, doc)) {
        for (const vertex of triangle) positions.push(vertex[0], vertex[1], vertex[2]);
      }
      return { kind: 'mesh', positions };
    }
  }
}

function solidFeature(
  entity: Entity,
  doc: CadDocument,
  raw: unknown,
  ctx: LowerContext,
  base: FeatureBase,
): Feature {
  const shape = lowerShape(entity, doc, raw, ctx);
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

function zero3(): Term3 {
  return [{ value: 0 }, { value: 0 }, { value: 0 }];
}

/** Non-geometric entity fields: a change limited to these is metadata, not a new feature. */
const METADATA_FIELDS = new Set(['name', 'tags', 'layerId', 'materialId', 'color']);

/** Deep equality with a numeric tolerance (replayed floats may differ in the last bits). */
function nearlyEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) <= EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => nearlyEqual(item, right[i]));
  }
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
  return after.position.every(
    (p, i) => Math.abs(p - (before.position[i] as number) - (delta[i] as number)) <= EPSILON,
  );
}

const BOOLEAN_KINDS: Readonly<Record<string, 'union' | 'cut' | 'intersect'>> = {
  boolean_union: 'union',
  boolean_subtract: 'cut',
  boolean_intersect: 'intersect',
};

function lowerParameters(
  doc: CadDocument,
  namer: Namer,
): {
  parameters: ProgramParameter[];
  identifiers: Map<string, string>;
} {
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
    if (parameter.error !== undefined || Number.isFinite(literal)) {
      return [{ name, identifier, value: parameter.value }];
    }
    const expression = translateExpression(parameter.expression, identifiers);
    return [
      expression === null
        ? { name, identifier, value: parameter.value }
        : { name, identifier, value: parameter.value, expression },
    ];
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

function outputsFor(doc: CadDocument, variables: ReadonlyMap<string, string>): ProgramOutput[] {
  return solids(doc).flatMap((entity): ProgramOutput[] => {
    const variable = variables.get(entity.id);
    if (variable === undefined) return [];
    return [
      entity.name !== undefined
        ? { variable, color: entity.color, name: entity.name }
        : { variable, color: entity.color },
    ];
  });
}

function lowerSnapshot(
  doc: CadDocument,
  parameters: ProgramParameter[],
  ctx: LowerContext,
  namer: Namer,
  notes: string[],
): FeatureProgram {
  const variables = new Map<string, string>();
  const features: Feature[] = [];
  for (const entity of solids(doc)) {
    const variable = namer.take(preferredVariable(entity));
    variables.set(entity.id, variable);
    const feature = solidFeature(entity, doc, undefined, ctx, {
      step: null,
      command: entity.kind,
      variable,
    });
    features.push(
      entity.name !== undefined && feature.op === 'solid'
        ? { ...feature, name: entity.name }
        : feature,
    );
  }
  return {
    units: doc.units,
    source: 'snapshot',
    parameters,
    features,
    outputs: outputsFor(doc, variables),
    notes,
  };
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
  const base = (variable: string): FeatureBase => ({
    step: stepNumber,
    command: step.name,
    variable,
  });

  const booleanKind = BOOLEAN_KINDS[step.name];
  const left = variables.get(String(child(event.params, 'a')));
  const right = variables.get(String(child(event.params, 'b')));
  if (
    booleanKind !== undefined &&
    createdSolid !== undefined &&
    created.length === 1 &&
    removed.length === 2 &&
    changed.length === 0 &&
    left !== undefined &&
    right !== undefined
  ) {
    variables.delete(String(child(event.params, 'b')));
    variables.delete(String(child(event.params, 'a')));
    variables.set(createdSolid.id, left);
    return [{ ...base(left), op: 'boolean', kind: booleanKind, left, right }];
  }

  const features: Feature[] = [];
  for (const id of removed) {
    const variable = variables.get(id);
    if (variable === undefined) continue;
    variables.delete(id);
    features.push({ ...base(variable), op: 'remove' });
  }
  for (const [previous, current] of changed) {
    const variable = variables.get(current.id);
    if (variable === undefined) continue;
    const delta = child(event.params, 'delta');
    if (step.name === 'move_entity' && isPureTranslation(previous, current, delta)) {
      features.push({
        ...base(variable),
        op: 'translate',
        delta: term3(delta, child(rawParams, 'delta'), ctx),
      });
    } else if (geometryEqual(previous, current)) {
      if (current.name !== undefined && current.name !== previous.name) {
        features.push({ ...base(variable), op: 'label', name: current.name });
      }
    } else {
      // Re-create from the evaluated state; remove first so the old solid does not linger.
      features.push({ ...base(variable), op: 'remove' });
      features.push(solidFeature(current, after, rawParams, ctx, base(variable)));
    }
  }
  for (const entity of created) {
    const variable = namer.take(preferredVariable(entity));
    variables.set(entity.id, variable);
    features.push(solidFeature(entity, after, rawParams, ctx, base(variable)));
    if (entity.kind === 'mesh' || entity.kind === 'instance') {
      notes.push(
        `step ${stepNumber} (${step.name}): ${entity.kind} '${entity.id}' has no analytic form; exported as a triangle mesh.`,
      );
    }
  }
  return features;
}

/** Why the replayed history does not reproduce `doc`'s solids (count or geometry), or null. */
function historyMismatch(doc: CadDocument, replayed: CadDocument): string | null {
  const expected = solids(doc);
  const actual = solids(replayed);
  if (expected.length !== actual.length) {
    return `featureHistory replays to ${actual.length} solid(s) but the document has ${expected.length}`;
  }
  const differing = expected.find((original, i) => {
    const regenerated = actual[i];
    return regenerated === undefined || !geometryEqual(original, regenerated);
  });
  return differing === undefined
    ? null
    : `featureHistory regenerates solid '${differing.id}' with different geometry`;
}

/**
 * Lower a document to a FeatureProgram. Prefers the featureHistory (parametric, ordered); falls
 * back to the current geometry when there is no history or replay does not reproduce the document.
 * @pure — replay works on fresh documents; `doc` is never mutated.
 * @invariant replay draws entity ids from the global `nextId` counter (as replay_history does), so
 *   ids minted after an export differ from ids minted without one; no document content changes.
 * @invariant history is used only when it regenerates every solid of `doc` (count + geometry).
 */
export function buildFeatureProgram(
  doc: CadDocument,
  getCommand: (name: string) => CommandDefinition<unknown> | undefined,
): FeatureProgram {
  const namer = new Namer();
  const { parameters, identifiers } = lowerParameters(doc, namer);
  const ctx: LowerContext = { identifiers, env: buildParamEnv(doc.parameters) };
  const notes: string[] = [];
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
  return {
    units: doc.units,
    source: 'history',
    parameters,
    features,
    outputs: outputsFor(replayed, variables),
    notes,
  };
}
