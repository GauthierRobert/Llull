import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { listCommands, toToolSchemas } from '@core/commands/registry';

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
  readonly additionalProperties?: SchemaNode | boolean;
  readonly required?: readonly string[];
}

/** Every object parameter with named properties, as `command.path`. */
function objectParams(name: string, path: string, node: SchemaNode): Array<[string, SchemaNode]> {
  const own: Array<[string, SchemaNode]> =
    node.type === 'object' && node.properties && Object.keys(node.properties).length > 0 ? [[`${name}${path}`, node]] : [];
  const children = Object.entries(node.properties ?? {}).flatMap(([key, child]) => objectParams(name, `${path}.${key}`, child));
  const items = node.items ? objectParams(name, `${path}[]`, node.items) : [];
  const branches = (node.anyOf ?? []).flatMap((branch, index) => objectParams(name, `${path}|${index}`, branch));
  const values = typeof node.additionalProperties === 'object' ? objectParams(name, `${path}{*}`, node.additionalProperties) : [];
  return [...own, ...children, ...items, ...branches, ...values];
}

interface ZodNode {
  readonly _zod: { readonly def: Record<string, unknown> & { readonly type: string } };
  isOptional(): boolean;
}

/** The zod node an `objectParams` path points at (`.key`, `[]`, `|branch`, `{*}`), unwrapping optional/nullable/default. */
function zodAt(root: ZodType, path: string): ZodNode | undefined {
  const unwrap = (node: ZodNode): ZodNode =>
    ['optional', 'nullable', 'default', 'prefault', 'readonly'].includes(node._zod.def.type)
      ? unwrap(node._zod.def['innerType'] as ZodNode)
      : node;
  let node: ZodNode | undefined = unwrap(root as unknown as ZodNode);
  for (const [, key, branch, marker] of path.matchAll(/\.([^.[|{]+)|\|(\d+)|(\[\]|\{\*\})/g)) {
    if (!node) return undefined;
    const def = node._zod.def;
    const next: unknown =
      key !== undefined
        ? (def['shape'] as Record<string, unknown> | undefined)?.[key]
        : branch !== undefined
          ? (def['options'] as unknown[] | undefined)?.[Number(branch)]
          : marker === '[]'
            ? def['element']
            : def['valueType'];
    node = next ? unwrap(next as ZodNode) : undefined;
  }
  return node;
}

/** True when the zod object at `path` declares no required field, so an absent JSON `required` list is correct. */
function allFieldsOptional(root: ZodType | undefined, path: string): boolean {
  const node = root ? zodAt(root, path) : undefined;
  const shape = node?._zod.def['shape'] as Record<string, ZodNode> | undefined;
  return shape !== undefined && Object.values(shape).every((field) => field.isOptional());
}

describe('nested parameter schemas', () => {
  const validators = new Map(listCommands().map((command) => [command.name, command.paramsValidator]));
  const all = listCommands().flatMap((command) => objectParams(command.name, '', command.paramsSchema as unknown as SchemaNode));
  it('declare the required fields of every object parameter (only all-optional zod objects may omit the list)', () => {
    const missing = all
      .filter(([path, node]) => (/[.[|{]/.test(path) ? !node.required : false))
      .map(([path]) => path)
      .filter((path) => {
        const name = path.split(/[.[|{]/)[0] ?? '';
        return !allFieldsOptional(validators.get(name), path.slice(name.length));
      });
    expect(missing).toEqual([]);
  });
  it('only require fields that exist', () => {
    for (const [path, node] of all) {
      for (const field of node.required ?? []) {
        expect(Object.keys(node.properties ?? {}), `${path} requires ${field}`).toContain(field);
      }
    }
  });
  it('emit the nested required lists into the tool schemas', () => {
    const constraint = toToolSchemas().find((schema) => schema.name === 'add_constraint');
    const properties = (constraint?.input_schema as unknown as SchemaNode).properties;
    expect(properties?.['constraint']?.required).toEqual(['kind', 'a']);
  });
});
