/**
 * Feature program — the language-neutral intermediate form a document is lowered to before it is
 * emitted as parametric source code (CadQuery, build123d, OpenSCAD, FreeCAD).
 *
 * @layer core/codegen
 * @pure
 * @invariant every Term's `value` equals the evaluated document geometry; `expression` (identifiers
 *   already mapped through `program.parameters`) is attached only when it evaluates to that value.
 * @invariant features follow featureHistory order; one variable per live solid.
 */

import type { CadDocument, DocumentUnit, Entity, FeatureStep, Vec3 } from '../model/types';
import { is3D } from '../model/types';
import type { CommandDefinition } from '../commands/types';
import { replayHistory, type ReplayStepEvent } from '../commands/history';
import { buildParamEnv } from '../commands/regenerate';
import { evaluateExpression, extractReferences } from '../commands/expression';
import { entityToTriangles } from '../commands/export';

export interface Term {
  readonly value: number;
  readonly expression?: string;
}

export type Term3 = readonly [Term, Term, Term];
export type Term2 = readonly [Term, Term];
export type Axis = 'x' | 'y' | 'z';

export type ShapeSpec =
  | { readonly kind: 'box'; readonly size: Term3 }
  | { readonly kind: 'cylinder'; readonly radius: Term; readonly height: Term }
  | { readonly kind: 'sphere'; readonly radius: Term }
  | { readonly kind: 'cone'; readonly radius: Term; readonly height: Term }
  | { readonly kind: 'torus'; readonly ringRadius: Term; readonly tubeRadius: Term }
  | { readonly kind: 'wedge'; readonly size: Term3 }
  | {
      readonly kind: 'pyramid';
      readonly baseWidth: Term;
      readonly baseDepth: Term;
      readonly height: Term;
    }
  | { readonly kind: 'extrusion'; readonly profile: readonly Term2[]; readonly depth: Term }
  | {
      readonly kind: 'revolution';
      readonly profile: readonly Term2[];
      readonly axis: Axis;
      readonly angle: Term;
      readonly segments: number;
    }
  /** Fallback for geometry without an analytic form: world-space triangle soup (9 numbers each). */
  | { readonly kind: 'mesh'; readonly positions: readonly number[] };

interface FeatureBase {
  /** 1-based featureHistory index that produced the feature; null in snapshot mode. */
  readonly step: number | null;
  /** Registry command name that produced the feature (or the entity kind in snapshot mode). */
  readonly command: string;
  readonly variable: string;
}

export type Feature =
  | (FeatureBase & {
      readonly op: 'solid';
      readonly shape: ShapeSpec;
      readonly position: Term3;
      /** Euler XYZ in radians (llull convention: Rz applied first, then Ry, then Rx). */
      readonly rotation: Term3;
      readonly color: string;
      readonly name?: string;
    })
  | (FeatureBase & {
      readonly op: 'boolean';
      readonly kind: 'union' | 'cut' | 'intersect';
      readonly left: string;
      readonly right: string;
    })
  | (FeatureBase & { readonly op: 'translate'; readonly delta: Term3 })
  | (FeatureBase & { readonly op: 'remove' })
  | (FeatureBase & { readonly op: 'label'; readonly name: string });

export interface ProgramParameter {
  /** llull parameter name (document key). */
  readonly name: string;
  /** Safe source-code identifier for the parameter. */
  readonly identifier: string;
  readonly value: number;
  /** Defining expression over other parameter identifiers; absent for literals and errors. */
  readonly expression?: string;
}

export interface ProgramOutput {
  readonly variable: string;
  readonly color: string;
  readonly name?: string;
}

export interface FeatureProgram {
  readonly units: DocumentUnit;
  /** `history` = lowered from featureHistory (parametric); `snapshot` = current geometry only. */
  readonly source: 'history' | 'snapshot';
  readonly parameters: readonly ProgramParameter[];
  readonly features: readonly Feature[];
  readonly outputs: readonly ProgramOutput[];
  /** Human/AI-readable notes about steps that could not be expressed analytically. */
  readonly notes: readonly string[];
}

/** Identifiers that must never be used for a parameter or a variable in any target language. */
const RESERVED = new Set([
  // Python keywords + builtins the generated code relies on
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
  'print',
  'range',
  'len',
  'min',
  'max',
  'abs',
  'round',
  'float',
  'int',
  'list',
  'tuple',
  'dict',
  'str',
  'math',
  'pi',
  'cq',
  'bd',
  'App',
  'Part',
  'Base',
  'FreeCAD',
  'doc',
  'result',
  // OpenSCAD keywords
  'module',
  'function',
  'let',
  'each',
  'true',
  'false',
  'undef',
  'include',
  'use',
  // llull runtime helpers emitted in generated code
  'param',
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'extrude',
  'revolve',
  'mesh',
  'union',
  'cut',
  'intersect',
  'translate',
  'remove',
  'label',
  'finish',
]);

const EPSILON = 1e-9;

/** Allocates unique, language-safe identifiers. */
class Namer {
  private readonly used = new Set<string>();

  take(preferred: string): string {
    let base = preferred.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    if (base === '' || base === '_') base = 'item';
    if (!/^[A-Za-z_]/.test(base)) base = `n_${base}`;
    // A reserved word (e.g. the helper `box`) is numbered from 1: box_1, box_2, ...
    const numbered = RESERVED.has(base);
    let candidate = numbered ? `${base}_1` : base;
    for (let n = 2; this.used.has(candidate); n++) candidate = `${base}_${n}`;
    this.used.add(candidate);
    return candidate;
  }
}

/**
 * Rewrite a llull expression into target-language source: identifiers mapped, grammar unchanged
 * (`+ - * /`, parentheses, decimal numbers are valid Python, OpenSCAD and FreeCAD Python).
 * @returns null when the expression contains anything outside the grammar or an unknown name.
 */
export function translateExpression(
  expression: string,
  identifiers: ReadonlyMap<string, string>,
): string | null {
  const token =
    /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|([-+*/()]))/y;
  const parts: string[] = [];
  let index = 0;
  const source = expression.trim();
  while (index < source.length) {
    token.lastIndex = index;
    const match = token.exec(source);
    if (!match) return null;
    index = token.lastIndex;
    const [, number, name, operator] = match;
    if (number !== undefined) parts.push(number);
    else if (name !== undefined) {
      const mapped = identifiers.get(name);
      if (mapped === undefined) return null;
      parts.push(mapped);
    } else if (operator !== undefined) parts.push(operator);
  }
  if (parts.length === 0) return null;
  return parts.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
}

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
        segments: entity.segments,
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

function geometryEqual(a: Entity, b: Entity): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (METADATA_FIELDS.has(key)) continue;
    const left = (a as unknown as Record<string, unknown>)[key];
    const right = (b as unknown as Record<string, unknown>)[key];
    if (left !== right && JSON.stringify(left) !== JSON.stringify(right)) return false;
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

  const parameters = ordered.map((name): ProgramParameter => {
    const parameter = doc.parameters[name]!;
    const identifier = identifiers.get(name)!;
    const literal = Number(parameter.expression);
    if (parameter.error !== undefined || Number.isFinite(literal)) {
      return { name, identifier, value: parameter.value };
    }
    const expression = translateExpression(parameter.expression, identifiers);
    return expression === null
      ? { name, identifier, value: parameter.value }
      : { name, identifier, value: parameter.value, expression };
  });
  return { parameters, identifiers };
}

function solidIds(doc: CadDocument): string[] {
  return doc.order.filter((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity);
  });
}

function preferredVariable(entity: Entity): string {
  return entity.name !== undefined && entity.name.trim() !== '' ? entity.name : entity.kind;
}

function outputsFor(doc: CadDocument, variables: ReadonlyMap<string, string>): ProgramOutput[] {
  return solidIds(doc).flatMap((id): ProgramOutput[] => {
    const entity = doc.entities[id]!;
    const variable = variables.get(id);
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
  for (const id of solidIds(doc)) {
    const entity = doc.entities[id]!;
    const variable = namer.take(preferredVariable(entity));
    variables.set(id, variable);
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
  const beforeIds = new Set(solidIds(before));
  const afterIds = solidIds(after);
  const created = afterIds.filter((id) => !beforeIds.has(id));
  const removed = [...beforeIds].filter((id) => after.entities[id] === undefined);
  const changed = afterIds.filter(
    (id) => beforeIds.has(id) && after.entities[id] !== before.entities[id],
  );
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
    created.length === 1 &&
    removed.length === 2 &&
    changed.length === 0 &&
    left !== undefined &&
    right !== undefined
  ) {
    variables.delete(String(child(event.params, 'b')));
    variables.delete(String(child(event.params, 'a')));
    variables.set(created[0]!, left);
    return [{ ...base(left), op: 'boolean', kind: booleanKind, left, right }];
  }

  const features: Feature[] = [];
  for (const id of removed) {
    const variable = variables.get(id);
    if (variable === undefined) continue;
    variables.delete(id);
    features.push({ ...base(variable), op: 'remove' });
  }
  for (const id of changed) {
    const variable = variables.get(id);
    const previous = before.entities[id]!;
    const current = after.entities[id]!;
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
  for (const id of created) {
    const entity = after.entities[id]!;
    const variable = namer.take(preferredVariable(entity));
    variables.set(id, variable);
    features.push(solidFeature(entity, after, rawParams, ctx, base(variable)));
    if (entity.kind === 'mesh' || entity.kind === 'instance') {
      notes.push(
        `step ${stepNumber} (${step.name}): ${entity.kind} '${id}' has no analytic form; exported as a triangle mesh.`,
      );
    }
  }
  return features;
}

/**
 * Lower a document to a FeatureProgram. Prefers the featureHistory (parametric, ordered); falls
 * back to the current geometry when there is no history or replay does not reproduce the document.
 * @pure — replay works on fresh documents; `doc` is never mutated.
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

  const expected = solidIds(doc).length;
  const actual = solidIds(replayed).length;
  if (expected !== actual) {
    notes.push(
      `featureHistory replays to ${actual} solid(s) but the document has ${expected}; exported the current geometry without its feature history.`,
    );
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
