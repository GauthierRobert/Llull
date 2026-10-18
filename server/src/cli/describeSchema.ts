/** `llull describe` text: the full nested parameter structure (objects, arrays, records, unions) as indented lines. */
import type { ParamsSchema } from '@core/commands/types';

/** Loose view of a published JSON-Schema node (records use `additionalProperties`, literals `const`). */
interface SchemaNode {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  default?: unknown;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  additionalProperties?: SchemaNode | boolean;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
}

const MAX_DEPTH = 6;
const MAX_ENUM_VALUES = 12;
const MAX_DEFAULT_CHARS = 60;

const show = (value: unknown): string => JSON.stringify(value) ?? String(value);
const branchesOf = (node: SchemaNode): SchemaNode[] | undefined => node.anyOf ?? node.oneOf;
const recordValue = (node: SchemaNode): SchemaNode | undefined =>
  typeof node.additionalProperties === 'object' ? node.additionalProperties : undefined;

function hasStructure(node: SchemaNode): boolean {
  if (node.properties !== undefined && Object.keys(node.properties).length > 0) return true;
  if (node.items !== undefined && hasStructure(node.items)) return true;
  const value = recordValue(node);
  if (value !== undefined && hasStructure(value)) return true;
  return branchesOf(node)?.some(hasStructure) ?? false;
}

/** `kind:"x"` when a property of the branch is a single-value enum / const, else undefined. */
function discriminator(node: SchemaNode): string | undefined {
  const entries = Object.entries(node.properties ?? {});
  const literal = (spec: SchemaNode): unknown =>
    spec.const !== undefined ? spec.const : spec.enum?.length === 1 ? spec.enum[0] : undefined;
  const found =
    entries.find(([key, spec]) => key === 'kind' && literal(spec) !== undefined) ?? entries.find(([, spec]) => literal(spec) !== undefined);
  return found === undefined ? undefined : `${found[0]}:${show(literal(found[1]))}`;
}

function enumLabel(values: readonly unknown[]): string {
  const shown = values.slice(0, MAX_ENUM_VALUES).map(show).join('|');
  return values.length > MAX_ENUM_VALUES ? `${shown}|…(+${values.length - MAX_ENUM_VALUES})` : shown;
}

function typeLabel(node: SchemaNode): string {
  if (node.const !== undefined) return show(node.const);
  if (node.enum !== undefined) return enumLabel(node.enum);
  const branches = branchesOf(node);
  if (branches !== undefined) return branches.map(branchLabel).join(' | ');
  if (node.type === 'array' && node.items !== undefined) {
    const inner = typeLabel(node.items);
    return `${branchesOf(node.items) !== undefined ? `(${inner})` : inner}[]`;
  }
  const value = recordValue(node);
  if (value !== undefined && node.properties === undefined) return `record<string, ${typeLabel(value)}>`;
  return node.type ?? 'any';
}

const branchLabel = (branch: SchemaNode): string => discriminator(branch) ?? typeLabel(branch);

function defaultSuffix(node: SchemaNode): string {
  if (node.default === undefined) return '';
  const text = show(node.default);
  return `, default ${text.length > MAX_DEFAULT_CHARS ? `${text.slice(0, MAX_DEFAULT_CHARS)}…` : text}`;
}

/** Lines describing what lies below a value: its properties, element/record-value structure, union branches. */
function structureLines(node: SchemaNode, indent: string, depth: number): string[] {
  if (!hasStructure(node)) return [];
  if (depth >= MAX_DEPTH) return [`${indent}…`];
  const lines: string[] = [];
  if (node.properties !== undefined) lines.push(...propertyLines(node.properties, node.required ?? [], indent, depth));
  if (node.items !== undefined) lines.push(...structureLines(node.items, indent, depth + 1));
  const value = recordValue(node);
  if (value !== undefined && hasStructure(value)) lines.push(`${indent}each value:`, ...structureLines(value, `${indent}  `, depth + 1));
  const branches = branchesOf(node);
  if (branches !== undefined && branches.some(hasStructure)) {
    lines.push(`${indent}one of:`);
    for (const branch of branches) {
      lines.push(`${indent}- ${branchLabel(branch)}${branch.description !== undefined ? `: ${branch.description}` : ''}`);
      lines.push(...structureLines(branch, `${indent}  `, depth + 1));
    }
  }
  return lines;
}

function propertyLines(properties: Record<string, SchemaNode>, required: readonly string[], indent: string, depth: number): string[] {
  return Object.entries(properties).flatMap(([key, spec]) => {
    const flag = required.includes(key) ? ', required' : '';
    const description = spec.description !== undefined ? `: ${spec.description}` : '';
    const line = `${indent}- ${key} (${typeLabel(spec)}${flag}${defaultSuffix(spec)})${description}`;
    return [line, ...structureLines(spec, `${indent}  `, depth + 1)];
  });
}

/** The `Params:` body of a tool: one line per parameter, nested structure indented below it. */
export function paramsLines(schema: ParamsSchema): string[] {
  return propertyLines(schema.properties as unknown as Record<string, SchemaNode>, schema.required, '', 0);
}
