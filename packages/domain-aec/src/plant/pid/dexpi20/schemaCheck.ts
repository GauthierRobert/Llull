/**
 * Offline check of a DEXPI 2.0 instance against the rules of `DEXPI_XML_Schema.xsd` (pack file `validation/data/dexpi20/`): element names, required
 * attributes, the `name` / `nameReference` / `ID` / `#id` patterns, child order and multiplicity, value lexical forms, unique ids. The XSD is not parsed
 * at run time (no network, no schema engine): the rules of its instance part are written down here and tested against `xmllint` when it is installed.
 * Linear in the file; never throws.
 */

import { XMLNS_NAMESPACE, xmlChildren, type XmlElement } from '@lib/xmlRead';

export interface SchemaViolation {
  /** `line N, column M` of the element. */
  readonly path: string;
  readonly message: string;
}

export interface SchemaReport {
  readonly valid: boolean;
  /** Total number of violations (the list is capped). */
  readonly count: number;
  readonly violations: readonly SchemaViolation[];
}

const MAX_LISTED = 100;

const NAME = '[A-Za-z_][A-Za-z_0-9]*';
const NAME_REFERENCE = `(?:${NAME})?/${NAME}(?:\\.${NAME})*`;
const ID_REFERENCE = `#${NAME}`;
const whole = (pattern: string): RegExp => new RegExp(`^(?:${pattern})$`);
const PATTERNS = {
  name: whole(NAME),
  nameReference: whole(NAME_REFERENCE),
  nameOrNameReference: whole(`${NAME}|${NAME_REFERENCE}`),
  nameOrIdReference: whole(`${NAME_REFERENCE}|${ID_REFERENCE}`),
  nameOrIdReferences: whole(`(?:${NAME_REFERENCE}|${ID_REFERENCE})(?: (?:${NAME_REFERENCE}|${ID_REFERENCE}))*`),
  anyUri: /^[^\s]*$/,
} as const;

type AttributeType = keyof typeof PATTERNS;

interface Rule {
  readonly attributes: Readonly<Record<string, { readonly type: AttributeType | 'id'; readonly required: boolean }>>;
  /** Child elements allowed, in the order of their first appearance in a valid file; absent means no element children. */
  readonly children?: readonly string[];
  /** Lexical check of the text of a leaf element. */
  readonly text?: (text: string) => boolean;
  readonly minChildren?: number;
}

const VALUE_ELEMENTS = ['AggregatedDataValue', 'DataReference', 'Boolean', 'DateTime', 'Double', 'Integer', 'String', 'Undefined'];

/** Elements of the type-definition part of the schema (Package, classes, data types): accepted without looking inside. */
const DEFINITIONS = new Set([
  'Package',
  'AbstractClass',
  'ConcreteClass',
  'ClassExtension',
  'AbstractDataType',
  'AggregatedDataType',
  'Enumeration',
  'BooleanType',
  'DateTimeType',
  'DoubleType',
  'IntegerType',
  'StringType',
  'UndefinedType',
]);

const required = (type: AttributeType | 'id'): Rule['attributes'][string] => ({ type, required: true });
const optional = (type: AttributeType | 'id'): Rule['attributes'][string] => ({ type, required: false });

const RULES: Readonly<Record<string, Rule>> = {
  Model: { attributes: { name: required('name'), uri: required('anyUri') }, children: ['Import', 'Object', 'Data'] },
  Import: { attributes: { source: required('anyUri'), prefix: required('name') } },
  Object: {
    attributes: { name: optional('name'), id: optional('id'), type: required('nameReference') },
    children: ['Components', 'Data', 'References'],
  },
  Components: { attributes: { property: required('nameOrNameReference') }, children: ['Object', 'ObjectReference'], minChildren: 1 },
  ObjectReference: { attributes: { object: required('nameOrIdReference') } },
  References: { attributes: { property: required('nameOrNameReference'), objects: required('nameOrIdReferences') } },
  Data: { attributes: { property: required('nameOrNameReference') }, children: VALUE_ELEMENTS, minChildren: 1 },
  DataReference: { attributes: { data: required('nameOrIdReference') } },
  AggregatedDataValue: { attributes: { type: required('nameReference') }, children: ['Data'] },
  Undefined: { attributes: {} },
  Boolean: { attributes: {}, text: (text) => /^(?:true|false|0|1)$/.test(text.trim()) },
  DateTime: {
    attributes: {},
    text: (text) => /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text.trim()),
  },
  Double: { attributes: {}, text: (text) => /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/.test(text.trim()) },
  Integer: { attributes: {}, text: (text) => /^[+-]?\d+$/.test(text.trim()) },
  String: { attributes: {}, text: () => true },
};

const where = (el: XmlElement): string => `line ${el.line}, column ${el.column}`;

/** The rank of a child among the allowed ones of its parent: Model needs Import* then Object* then Data*, the others take any order. */
const ORDERED = new Set(['Model']);

export function checkDexpi20(root: XmlElement): SchemaReport {
  const violations: SchemaViolation[] = [];
  let count = 0;
  const report = (el: XmlElement, message: string): void => {
    count++;
    if (violations.length < MAX_LISTED) violations.push({ path: where(el), message });
  };
  const ids = new Set<string>();
  if (root.local !== 'Model') report(root, `the root element is <${root.name}>, expected <Model>`);
  const stack: XmlElement[] = [root];
  for (let el = stack.pop(); el !== undefined; el = stack.pop()) {
    const rule = Object.hasOwn(RULES, el.local) ? RULES[el.local] : undefined;
    if (rule === undefined) {
      if (!DEFINITIONS.has(el.local)) report(el, `element <${el.name}> is not allowed here`);
      continue;
    }
    const seen = new Set<string>();
    for (const attribute of el.attributes) {
      if (attribute.namespace === XMLNS_NAMESPACE) continue;
      const spec = Object.hasOwn(rule.attributes, attribute.name) ? rule.attributes[attribute.name] : undefined;
      seen.add(attribute.name);
      if (spec === undefined) report(el, `attribute "${attribute.name}" is not allowed on <${el.name}>`);
      else if (spec.type === 'id') {
        if (!PATTERNS.name.test(attribute.value)) report(el, `id "${attribute.value}" is not a valid name`);
        else if (ids.has(attribute.value)) report(el, `id "${attribute.value}" is used twice`);
        else ids.add(attribute.value);
      } else if (!PATTERNS[spec.type].test(attribute.value))
        report(el, `attribute ${attribute.name}="${attribute.value}" does not match ${spec.type}`);
    }
    for (const [name, spec] of Object.entries(rule.attributes))
      if (spec.required && !seen.has(name)) report(el, `<${el.name}> needs attribute "${name}"`);
    const elements = xmlChildren(el);
    const text = el.children.flatMap((child) => (child.type === 'text' ? [child.value] : [])).join('');
    if (rule.text !== undefined) {
      if (elements.length > 0) report(el, `<${el.name}> holds text only`);
      else if (!rule.text(text)) report(el, `<${el.name}> value "${text.slice(0, 40)}" is not a valid ${el.local}`);
    } else if (text.trim() !== '') report(el, `<${el.name}> holds elements only, found text`);
    const allowed = rule.children ?? [];
    let rank = 0;
    const accepted: XmlElement[] = [];
    for (const child of elements) {
      const definition = el.local === 'Model' && DEFINITIONS.has(child.local);
      const position = definition ? 1 : allowed.indexOf(child.local);
      if (position < 0) {
        report(child, `<${child.name}> is not allowed in <${el.name}>`);
        continue;
      }
      accepted.push(child);
      if (ORDERED.has(el.local)) {
        if (position < rank) report(child, `<${child.name}> comes after a later kind of child of <${el.name}>`);
        rank = Math.max(rank, position);
      }
    }
    if (rule.minChildren !== undefined && elements.length < rule.minChildren)
      report(el, `<${el.name}> needs at least ${rule.minChildren} child element`);
    for (let index = accepted.length - 1; index >= 0; index--) stack.push(accepted[index] as XmlElement);
  }
  return { valid: count === 0, count, violations };
}
