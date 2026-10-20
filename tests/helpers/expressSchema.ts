/**
 * A small EXPRESS reader and Part 21 instance checker for the ISO 10303-242 MIM long form (the schema file is public, see
 * docs/aerospace/06-composites/validation/sources.md; it is NOT in the repo): for each record of a Part 21 text it checks that the entity exists, that the
 * number of attributes equals the schema's (supertype attributes first), that `$` stands only for OPTIONAL attributes, and that every `#n` reference points at an
 * instance whose entity is the attribute's type or a subtype of it (SELECT and alias types resolved). WHERE rules, UNIQUE rules, derived and redeclared
 * attributes, aggregate bounds and the value ranges of typed literals are NOT evaluated.
 */

import { readFileSync } from 'node:fs';

interface Attribute {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly aggregate: boolean;
}

interface EntityDefinition {
  readonly name: string;
  readonly supertypes: readonly string[];
  readonly own: readonly Attribute[];
}

type TypeDefinition =
  | { readonly kind: 'select'; readonly members: readonly string[] }
  | { readonly kind: 'alias'; readonly of: string; readonly aggregate: boolean };

export class ExpressSchema {
  readonly entities = new Map<string, EntityDefinition>();
  readonly types = new Map<string, TypeDefinition>();

  constructor(source: string) {
    const clean = source.replace(/\(\*[\s\S]*?\*\)/g, ' ').replace(/--[^\n]*/g, ' ');
    for (const match of clean.matchAll(/\bTYPE\s+(\w+)\s*=\s*([\s\S]*?);\s*(?:WHERE[\s\S]*?)?END_TYPE\s*;/g)) {
      const name = (match[1] ?? '').toLowerCase();
      const body = (match[2] ?? '').replace(/\s+/g, ' ').trim();
      const select = /^(?:EXTENSIBLE\s+)?(?:GENERIC_ENTITY\s+)?SELECT\s*(?:BASED_ON[^()]*WITH)?\s*\(([\s\S]*)\)$/i.exec(body);
      if (select?.[1] !== undefined)
        this.types.set(name, {
          kind: 'select',
          members: select[1]
            .split(',')
            .map((member) => member.trim().toLowerCase())
            .filter(Boolean),
        });
      else {
        const aggregate = /^(?:LIST|SET|BAG|ARRAY)\b/i.test(body);
        const of = /(\w+)\s*$/.exec(body)?.[1];
        this.types.set(name, { kind: 'alias', of: (of ?? body).toLowerCase(), aggregate });
      }
    }
    for (const match of clean.matchAll(/\bENTITY\s+(\w+)([\s\S]*?)\bEND_ENTITY\s*;/g)) {
      const name = (match[1] ?? '').toLowerCase();
      const text = match[2] ?? '';
      const headerEnd = text.indexOf(';');
      const header = text.slice(0, headerEnd);
      const supertypes = (/SUBTYPE\s+OF\s*\(([^)]*)\)/i.exec(header)?.[1] ?? '')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
      const rest = text.slice(headerEnd + 1);
      const cut = rest.search(/\b(?:DERIVE|INVERSE|UNIQUE|WHERE)\b/);
      const body = cut < 0 ? rest : rest.slice(0, cut);
      const own: Attribute[] = [];
      for (const declaration of body.split(';')) {
        const parts = /^\s*([\w\\.,\s]+?)\s*:\s*([\s\S]+)$/.exec(declaration);
        if (parts?.[1] === undefined || parts[2] === undefined || parts[1].includes('\\')) continue;
        const type = parts[2].replace(/\s+/g, ' ').trim();
        const optional = /^OPTIONAL\b/i.test(type);
        const stripped = type.replace(/^OPTIONAL\s+/i, '');
        const aggregate = /^(?:LIST|SET|BAG|ARRAY)\b/i.test(stripped);
        const element = /(\w+)\s*$/.exec(stripped.replace(/\(\s*\d+[^)]*\)\s*$/, ''))?.[1] ?? stripped;
        for (const attribute of parts[1].split(','))
          own.push({ name: attribute.trim().toLowerCase(), type: element.toLowerCase(), optional, aggregate });
      }
      this.entities.set(name, { name, supertypes, own });
    }
  }

  /** Attributes of a simple instance: supertypes' first (depth first, each entity once), then the entity's own. */
  attributes(name: string, seen = new Set<string>()): Attribute[] {
    const definition = this.entities.get(name);
    if (definition === undefined || seen.has(name)) return [];
    seen.add(name);
    return [...definition.supertypes.flatMap((supertype) => this.attributes(supertype, seen)), ...definition.own];
  }

  isA(name: string, target: string, depth = 0): boolean {
    if (name === target) return true;
    if (depth > 30) return false;
    return (this.entities.get(name)?.supertypes ?? []).some((supertype) => this.isA(supertype, target, depth + 1));
  }

  /** True when an instance of any of `names` may stand where `type` (an entity, a SELECT or an alias) is declared. */
  accepts(type: string, names: readonly string[], depth = 0): boolean {
    if (depth > 12) return true;
    if (this.entities.has(type)) return names.some((name) => this.isA(name, type));
    const definition = this.types.get(type);
    if (definition === undefined) return true;
    if (definition.kind === 'alias') return this.accepts(definition.of, names, depth + 1);
    return definition.members.some((member) => this.accepts(member, names, depth + 1));
  }
}

export const loadSchema = (path: string): ExpressSchema => new ExpressSchema(readFileSync(path, 'utf8'));

/** Splits the top-level arguments of an entity body `NAME(a,(b,c),'d')`. */
function splitArguments(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] as string;
    if (quoted) {
      current += char;
      if (char === "'") {
        if (inner[i + 1] === "'") current += inner[++i];
        else quoted = false;
      }
    } else if (char === "'") {
      quoted = true;
      current += char;
    } else if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim() !== '' || out.length > 0) out.push(current.trim());
  return out;
}

/** `[name, arguments]` partial instances of a record body: one for a simple instance, several for a complex one. */
export function partials(body: string): [string, string[]][] {
  const text = body.trim();
  const found: [string, string[]][] = [];
  const scan = text.startsWith('(') && !/^\(\s*#|^\(\s*'/.test(text) ? text.slice(1, -1) : text;
  let index = 0;
  while (index < scan.length) {
    const match = /^\s*([A-Z0-9_]+)\s*\(/.exec(scan.slice(index));
    if (match === null) break;
    const start = index + match[0].length;
    let depth = 1;
    let position = start;
    let inString = false;
    while (position < scan.length && depth > 0) {
      const char = scan[position] as string;
      if (inString) {
        if (char === "'") {
          if (scan[position + 1] === "'") position++;
          else inString = false;
        }
      } else if (char === "'") inString = true;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
      position++;
    }
    found.push([(match[1] ?? '').toLowerCase(), splitArguments(scan.slice(start, position - 1))]);
    index = position;
  }
  return found;
}

export interface Violation {
  readonly record: number;
  readonly entity: string;
  readonly message: string;
}

/** Checks the records `ids` of `bodies` (a `parseRecords` map) against the schema. */
export function checkRecords(
  schema: ExpressSchema,
  bodies: ReadonlyMap<number, string>,
  ids: Iterable<number>,
): { checked: number; violations: Violation[] } {
  const entityOf = (id: number): string[] => partials(bodies.get(id) ?? '').map(([name]) => name);
  const violations: Violation[] = [];
  let checked = 0;
  for (const id of ids) {
    const parts = partials(bodies.get(id) ?? '');
    if (parts.length === 0) continue;
    checked++;
    const complex = parts.length > 1;
    for (const [name, args] of parts) {
      if (!schema.entities.has(name)) {
        violations.push({ record: id, entity: name, message: 'unknown entity' });
        continue;
      }
      const attributes = complex ? (schema.entities.get(name)?.own ?? []) : schema.attributes(name);
      if (args.length !== attributes.length) {
        violations.push({ record: id, entity: name, message: `${args.length} arguments, the schema has ${attributes.length}` });
        continue;
      }
      attributes.forEach((attribute, k) => {
        const argument = args[k] as string;
        if (argument === '$') {
          if (!attribute.optional) violations.push({ record: id, entity: name, message: `${attribute.name} is not OPTIONAL but is $` });
          return;
        }
        if (argument === '*') return;
        const references = [...argument.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
        if (attribute.aggregate && !argument.startsWith('('))
          violations.push({ record: id, entity: name, message: `${attribute.name} should be an aggregate` });
        for (const reference of references) {
          const target = entityOf(reference);
          if (target.length === 0)
            violations.push({ record: id, entity: name, message: `${attribute.name} refers to missing #${reference}` });
          else if (!schema.accepts(attribute.type, target))
            violations.push({
              record: id,
              entity: name,
              message: `${attribute.name} (${attribute.type}) refers to #${reference} which is ${target.join('+')}`,
            });
        }
      });
    }
  }
  return { checked, violations };
}
