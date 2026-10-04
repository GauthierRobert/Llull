/**
 * @layer tests/production/oracle
 *
 * Minimal, independent IFC (ISO 10303-21 STEP physical file) reader: what a BIM coordinator's
 * viewer checks first — entity counts, unique GlobalIds, resolvable references, storeys and which
 * storey contains each element. Shares no code with llull's IFC writer.
 */

export type StepValue = string | StepValue[];

export interface StepEntity {
  id: number;
  type: string;
  args: StepValue[];
}

export interface IfcFile {
  schema: string;
  entities: Map<number, StepEntity>;
  /** Parse or structure errors (an empty list means the file is well-formed). */
  errors: string[];
}

/** Split a STEP argument list into values; strings keep their quotes, lists become arrays. */
export function parseArgs(text: string): StepValue[] {
  const root: StepValue[] = [];
  const stack: StepValue[][] = [root];
  let token = '';
  let inString = false;
  const flush = (): void => {
    const trimmed = token.trim();
    if (trimmed !== '') stack[stack.length - 1]?.push(trimmed);
    token = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inString) {
      token += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          token += "'";
          i++;
        } else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      token += ch;
    } else if (ch === '(') {
      // A typed value `IFCMASSMEASURE(55000.)` becomes one list whose first item is its type name.
      const typeName = token.trim();
      token = '';
      const list: StepValue[] = typeName === '' ? [] : [typeName];
      stack[stack.length - 1]?.push(list);
      stack.push(list);
    } else if (ch === ')') {
      flush();
      stack.pop();
    } else if (ch === ',') {
      flush();
    } else token += ch;
  }
  flush();
  return root;
}

/** Parse an IFC file: header schema + DATA section entities. */
export function parseIfc(text: string): IfcFile {
  const errors: string[] = [];
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/.exec(text)?.[1] ?? '';
  if (!text.startsWith('ISO-10303-21;')) errors.push('missing ISO-10303-21 header');
  if (!/END-ISO-10303-21;\s*$/.test(text)) errors.push('missing END-ISO-10303-21 trailer');
  const data = /DATA;([\s\S]*?)ENDSEC;/.exec(text)?.[1] ?? '';
  const entities = new Map<number, StepEntity>();
  for (const statement of splitStatements(data)) {
    const match = /^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)$/.exec(statement);
    if (!match) {
      errors.push(`unparsable statement: ${statement.slice(0, 60)}`);
      continue;
    }
    const id = Number(match[1]);
    if (entities.has(id)) errors.push(`duplicate entity #${id}`);
    entities.set(id, { id, type: match[2] ?? '', args: parseArgs(match[3] ?? '') });
  }
  for (const entity of entities.values()) {
    for (const ref of references(entity.args)) {
      if (!entities.has(ref))
        errors.push(`#${entity.id} ${entity.type} references missing #${ref}`);
    }
  }
  return { schema, entities, errors };
}

/** Statements end with ';' outside strings. */
function splitStatements(data: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (const ch of data) {
    if (ch === "'") inString = !inString;
    if (ch === ';' && !inString) {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
    } else current += ch;
  }
  return statements;
}

/** Every `#n` reference inside a value tree. */
export function references(values: StepValue[]): number[] {
  const refs: number[] = [];
  for (const value of values) {
    if (Array.isArray(value)) refs.push(...references(value));
    else if (/^#\d+$/.test(value)) refs.push(Number(value.slice(1)));
  }
  return refs;
}

export function ofType(file: IfcFile, type: string): StepEntity[] {
  return [...file.entities.values()].filter((entity) => entity.type === type);
}

export function countByType(file: IfcFile): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of file.entities.values()) counts[entity.type] = (counts[entity.type] ?? 0) + 1;
  return counts;
}

/** Unquote a STEP string value ('' → '); '$' and non-strings → ''. */
export function stepString(value: StepValue | undefined): string {
  if (typeof value !== 'string' || !value.startsWith("'")) return '';
  return value.slice(1, -1).replace(/''/g, "'");
}

const GUID_ALPHABET = /^[0-9A-Za-z_$]{22}$/;

/** IfcRoot GlobalIds (first argument of every entity that has one): malformed and duplicated. */
export function globalIdProblems(file: IfcFile): { malformed: string[]; duplicated: string[] } {
  const seen = new Set<string>();
  const malformed: string[] = [];
  const duplicated: string[] = [];
  for (const entity of file.entities.values()) {
    if (!isRooted(entity, file)) continue;
    const guid = stepString(entity.args[0]);
    if (!GUID_ALPHABET.test(guid)) malformed.push(`#${entity.id} ${entity.type} '${guid}'`);
    else if (seen.has(guid)) duplicated.push(guid);
    seen.add(guid);
  }
  return { malformed, duplicated };
}

/**
 * Rooted entities (IfcRoot subtypes) start with a quoted GlobalId, then an owner history (`$` or a
 * reference to IFCOWNERHISTORY), then a Name — decided by structure, so a GlobalId of the wrong
 * length is reported, not skipped.
 */
function isRooted(entity: StepEntity, file: IfcFile): boolean {
  const [first, owner] = entity.args;
  if (typeof first !== 'string' || !first.startsWith("'") || entity.args.length < 4) return false;
  if (owner === '$') return true;
  const ref = typeof owner === 'string' && /^#\d+$/.test(owner) ? Number(owner.slice(1)) : NaN;
  return file.entities.get(ref)?.type === 'IFCOWNERHISTORY';
}

/** Every number inside a value tree (typed values included), e.g. a property's nominal value. */
export function numbersIn(values: StepValue[]): number[] {
  const found: number[] = [];
  for (const value of values) {
    if (Array.isArray(value)) found.push(...numbersIn(value));
    else if (/^-?\d+(\.\d*)?(E[-+]?\d+)?$/i.test(value)) found.push(Number(value));
  }
  return found;
}

export interface IfcStorey {
  id: number;
  guid: string;
  name: string;
  elevation: number;
}

/** IFCBUILDINGSTOREY(GlobalId, OwnerHistory, Name, Description, ObjectType, Placement, Representation, LongName, CompositionType, Elevation). */
export function storeys(file: IfcFile): IfcStorey[] {
  return ofType(file, 'IFCBUILDINGSTOREY').map((entity) => ({
    id: entity.id,
    guid: stepString(entity.args[0]),
    name: stepString(entity.args[2]),
    elevation: Number(entity.args[9]),
  }));
}

/** Map element entity id → containing storey name (IFCRELCONTAINEDINSPATIALSTRUCTURE). */
export function containment(file: IfcFile): Map<number, string> {
  const names = new Map(storeys(file).map((storey) => [storey.id, storey.name]));
  const contained = new Map<number, string>();
  for (const rel of ofType(file, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const structure = references([rel.args[5] ?? '$'])[0];
    const storeyName = structure === undefined ? undefined : names.get(structure);
    if (storeyName === undefined) continue;
    for (const element of references([rel.args[4] ?? []])) contained.set(element, storeyName);
  }
  return contained;
}

/** Name attribute (3rd argument) of a rooted entity. */
export function entityName(entity: StepEntity): string {
  return stepString(entity.args[2]);
}
