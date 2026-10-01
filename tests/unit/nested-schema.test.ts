import { describe, expect, it } from 'vitest';
import { listCommands, toToolSchemas } from '@core/commands/registry';

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
  readonly required?: readonly string[];
}

/** Every object parameter with named properties, as `command.path`. */
function objectParams(name: string, path: string, node: SchemaNode): Array<[string, SchemaNode]> {
  const own: Array<[string, SchemaNode]> =
    node.type === 'object' && node.properties && Object.keys(node.properties).length > 0
      ? [[`${name}${path}`, node]]
      : [];
  const children = Object.entries(node.properties ?? {}).flatMap(([key, child]) =>
    objectParams(name, `${path}.${key}`, child),
  );
  const items = node.items ? objectParams(name, `${path}[]`, node.items) : [];
  return [...own, ...children, ...items];
}

describe('nested parameter schemas', () => {
  const all = listCommands().flatMap((command) =>
    objectParams(command.name, '', command.paramsSchema as unknown as SchemaNode),
  );

  it('declare the required fields of every object parameter (patch objects are all-optional)', () => {
    const missing = all
      .filter(([path, node]) =>
        path.includes('.') || path.includes('[]') ? !node.required : false,
      )
      .map(([path]) => path)
      .filter((path) => !/\.patch$/.test(path));
    expect(missing).toEqual([]);
  });

  it('only require fields that exist', () => {
    for (const [path, node] of all) {
      for (const field of node.required ?? []) {
        expect(Object.keys(node.properties ?? {}), `${path} requires ${field}`).toContain(field);
      }
    }
  });

  it('emit the nested required lists into the MCP tool schemas', () => {
    const constraint = toToolSchemas().find((schema) => schema.name === 'add_constraint');
    const properties = (constraint?.input_schema as unknown as SchemaNode).properties;
    expect(properties?.['constraint']?.required).toEqual(['kind', 'a', 'b']);
  });
});
