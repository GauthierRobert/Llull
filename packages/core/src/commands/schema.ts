/**
 * One schema per command: a zod object is the single source of the params TS type,
 * the agent-facing `paramsSchema` (MCP JSON Schema) and runtime validation in `execute`.
 *
 * @layer core/commands
 * @invariant `toParamsSchema(schema)` emits only the `ParamSpec` vocabulary (type, description,
 *   enum, items, properties, required) — the MCP tool surface is unchanged by migration.
 */

import { z } from 'zod';
import type { CadDocument, Vec2, Vec3 } from '../model/types';
import type { ExecutionContext } from './context';
import type {
  CommandAnnotations,
  CommandDefinition,
  CommandResult,
  ParamItemSpec,
  ParamSpec,
  ParamsSchema,
  ParamType,
} from './types';

export { z };

type ParamsObject = z.ZodObject;

interface Unwrapped {
  readonly core: z.ZodType;
  readonly optional: boolean;
  readonly description: string | undefined;
}

/** Strip optional/nullable/default wrappers, keeping the outermost description. */
function unwrap(schema: z.ZodType): Unwrapped {
  let current: z.ZodType = schema;
  let optional = false;
  let description = schema.description;
  for (;;) {
    const def = current.def as { type: string; innerType?: z.ZodType };
    if (
      (def.type === 'optional' ||
        def.type === 'default' ||
        def.type === 'nullable' ||
        def.type === 'catch') &&
      def.innerType
    ) {
      optional = optional || def.type === 'optional' || def.type === 'default';
      current = def.innerType;
      description ??= current.description;
      continue;
    }
    return { core: current, optional, description };
  }
}

function enumValues(core: z.ZodType): readonly (string | number)[] | undefined {
  const def = core.def as {
    type: string;
    entries?: Record<string, string | number>;
    values?: readonly unknown[];
    options?: readonly z.ZodType[];
  };
  if (def.type === 'enum' && def.entries) return Object.values(def.entries);
  if (def.type === 'literal' && def.values) {
    return def.values.filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    );
  }
  if (def.type === 'union' && def.options) {
    const nested = def.options.map((option) => enumValues(unwrap(option).core));
    if (nested.every((values) => values !== undefined)) return nested.flat() as (string | number)[];
  }
  return undefined;
}

function paramType(core: z.ZodType): ParamType {
  const def = core.def as { type: string; options?: readonly z.ZodType[] };
  switch (def.type) {
    case 'number':
    case 'int':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
    case 'tuple':
      return 'array';
    case 'object':
    case 'record':
    case 'unknown':
    case 'any':
      return 'object';
    case 'union': {
      const first = def.options?.[0];
      return first ? paramType(unwrap(first).core) : 'string';
    }
    case 'literal': {
      const values = enumValues(core) ?? [];
      return typeof values[0] === 'number' ? 'number' : 'string';
    }
    default:
      return 'string';
  }
}

function itemSchema(core: z.ZodType): z.ZodType | undefined {
  const def = core.def as { type: string; element?: z.ZodType; items?: readonly z.ZodType[] };
  // `untypedArray()` (element `any`) declares no `items` to agents.
  if (def.type === 'array' && (def.element?.def as { type?: string } | undefined)?.type === 'any') {
    return undefined;
  }
  if (def.type === 'array') return def.element;
  if (def.type === 'tuple') return def.items?.[0];
  return undefined;
}

function objectShape(core: z.ZodType): Record<string, z.ZodType> | undefined {
  const def = core.def as { type: string; shape?: Record<string, z.ZodType> };
  return def.type === 'object' ? def.shape : undefined;
}

function describeChildren(shape: Record<string, z.ZodType>): {
  properties: Record<string, ParamSpec>;
  required: string[];
} {
  const properties: Record<string, ParamSpec> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const { spec, optional } = toParamSpec(child, key);
    properties[key] = spec;
    if (!optional) required.push(key);
  }
  return { properties, required };
}

function toItemSpec(schema: z.ZodType): ParamItemSpec {
  const { core, description } = unwrap(schema);
  const spec: ParamItemSpec = { type: paramType(core) };
  if (description !== undefined) spec.description = description;
  fillStructure(spec, core);
  return spec;
}

function fillStructure(spec: ParamItemSpec, core: z.ZodType): void {
  const values = enumValues(core);
  if (values !== undefined && (core.def as { type: string }).type !== 'tuple') spec.enum = values;
  const item = itemSchema(core);
  if (item) spec.items = toItemSpec(item);
  const shape = objectShape(core);
  if (shape) {
    // `z.object({})` = an open object declared with `properties: {}`; `z.record` emits none.
    const { properties, required } = describeChildren(shape);
    spec.properties = properties;
    if (required.length > 0) spec.required = required;
  }
}

function toParamSpec(schema: z.ZodType, key: string): { spec: ParamSpec; optional: boolean } {
  const { core, optional, description } = unwrap(schema);
  if (description === undefined) {
    throw new Error(`paramsSchema property '${key}' needs a .describe() text for agents`);
  }
  const spec: ParamSpec = { type: paramType(core), description };
  fillStructure(spec, core);
  return { spec, optional };
}

/** Derive the agent-facing `paramsSchema` from a zod params object. */
export function toParamsSchema(schema: ParamsObject): ParamsSchema {
  const { properties, required } = describeChildren(schema.def.shape as Record<string, z.ZodType>);
  return { type: 'object', properties, required };
}

/** "path: message (got …)" for the first few issues — fed back to the agent as the summary. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(params)';
      const input = (issue as { input?: unknown }).input;
      const got = input === undefined ? '' : ` (got ${JSON.stringify(input) ?? String(input)})`;
      return `${path}: ${issue.message}${got}`;
    })
    .join('; ');
}

interface CommandSpec<S extends ParamsObject> {
  readonly name: string;
  readonly description: string;
  readonly params: S;
  readonly annotations?: CommandAnnotations;
  readonly run: (doc: CadDocument, params: z.output<S>, ctx?: ExecutionContext) => CommandResult;
}

/**
 * Define a command from one zod params schema.
 * @invariant unknown keys are preserved (loose object) so recorded/legacy params still run
 * @failure params failing the schema -> `execute` no-ops with `<name> rejected: invalid params …`
 */
export function defineCommand<S extends ParamsObject>(
  spec: CommandSpec<S>,
): CommandDefinition<z.output<S>> {
  const definition: CommandDefinition<z.output<S>> = {
    name: spec.name,
    description: spec.description,
    paramsSchema: toParamsSchema(spec.params),
    paramsValidator: z.looseObject(spec.params.shape),
    run: spec.run,
  };
  return spec.annotations ? { ...definition, annotations: spec.annotations } : definition;
}

/** 2-number vector `[x, y]` (local work-plane coordinates). */
export function vec2(description: string): z.ZodTuple<[z.ZodNumber, z.ZodNumber], null> {
  return z.tuple([z.number(), z.number()]).describe(description);
}

/** 3-number vector `[x, y, z]`. */
export function vec3(
  description: string,
): z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null> {
  return z.tuple([z.number(), z.number(), z.number()]).describe(description);
}

/**
 * `[x, y]`-typed vector that accepts any number array at runtime — for commands whose `run`
 * validates or tolerates the length itself (e.g. 3-element points passed to 2D commands).
 */
export function looseVec2(description: string): z.ZodType<Vec2> {
  return z.array(z.number()).describe(description) as unknown as z.ZodType<Vec2>;
}

/** `[x, y, z]`-typed vector that accepts any number array at runtime (see `looseVec2`). */
export function looseVec3(description: string): z.ZodType<Vec3> {
  return z.array(z.number()).describe(description) as unknown as z.ZodType<Vec3>;
}

/** Array whose elements the agent-facing schema leaves undeclared (no `items`); `run` validates. */
export function untypedArray(description: string): z.ZodArray<z.ZodAny> {
  return z.array(z.any()).describe(description);
}

/**
 * Advertise `schema` to agents but never reject at runtime: `run` receives the raw value and keeps
 * its own fallback (e.g. a malformed rotation falls back to [0, 0, 0]). Use only where the command
 * already tolerated bad input before the zod migration.
 */
export function tolerant<T extends z.ZodType>(schema: T): z.ZodCatch<T> {
  return schema.catch(undefined as never);
}

/** Optional hex-color param; `defaultColor` is advertised in the description and applied by `run`. */
export function colorField(defaultColor: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .describe(`Hex color string, e.g. "#c8553d". Defaults to "${defaultColor}".`)
    .optional();
}
