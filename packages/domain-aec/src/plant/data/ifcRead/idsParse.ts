/**
 * Reads an IDS 1.0 document (XML, untrusted) into the subset of `idsTypes.ts`. The XML goes through `@lib/xmlRead` (no DTD, bounded depth / elements). Patterns are
 * compiled anchored and refused when their shape can backtrack catastrophically (a quantified group that holds a quantifier or an alternation), so a hostile IDS
 * cannot stall the checker. An unsupported facet or restriction is a coded refusal, never a silent pass.
 */

import { readXml, xmlAttr, xmlChildren, xmlText, type XmlElement } from '@lib/xmlRead';
import type { Cardinality, EntityFacet, Facet, Ids, Specification, ValueRule } from './idsTypes';

export type IdsParse =
  | { readonly ok: true; readonly ids: Ids }
  | { readonly ok: false; readonly code: 'DAT_IDS_PARSE' | 'DAT_IDS_UNSUPPORTED_FACET'; readonly message: string };

class IdsFailure {
  constructor(
    readonly code: 'DAT_IDS_PARSE' | 'DAT_IDS_UNSUPPORTED_FACET',
    readonly message: string,
  ) {}
}

const MAX_SPECIFICATIONS = 1000;
const MAX_FACETS = 100;
const MAX_PATTERN = 500;
const MAX_ENUMERATION = 10_000;
const UNSUPPORTED_RESTRICTIONS = ['length', 'minLength', 'maxLength', 'fractionDigits', 'totalDigits', 'whiteSpace'];
const GROUP_WITH_INNER = /\((?:[^()\\]|\\.)*(?:[+*{|]|\\.[+*])(?:[^()\\]|\\.)*\)[+*{]/;

const unsupported = (message: string): IdsFailure => new IdsFailure('DAT_IDS_UNSUPPORTED_FACET', message);
const invalid = (message: string): IdsFailure => new IdsFailure('DAT_IDS_PARSE', message);

function pattern(source: string): RegExp {
  if (source.length > MAX_PATTERN) throw unsupported(`an xs:pattern longer than ${MAX_PATTERN} characters`);
  if (GROUP_WITH_INNER.test(source))
    throw unsupported(
      `the xs:pattern "${source.slice(0, 60)}" repeats a group that holds a quantifier or an alternation (it can backtrack without limit)`,
    );
  try {
    return new RegExp(`^(?:${source})$`, 'u');
  } catch {
    throw invalid(`the xs:pattern "${source.slice(0, 60)}" is not a regular expression`);
  }
}

function valueRule(element: XmlElement | undefined): ValueRule | undefined {
  if (element === undefined) return undefined;
  const simple = xmlChildren(element, 'simpleValue')[0];
  if (simple !== undefined) return { simple: xmlText(simple) };
  const restriction = xmlChildren(element, 'restriction')[0];
  if (restriction === undefined) throw invalid(`<${element.local}> holds neither a simpleValue nor an xs:restriction`);
  const enumeration: string[] = [];
  const patterns: RegExp[] = [];
  const bounds: Record<string, number> = {};
  for (const child of restriction.children) {
    if (child.type !== 'element') continue;
    const value = xmlAttr(child, 'value') ?? '';
    if (child.local === 'enumeration') {
      if (enumeration.length >= MAX_ENUMERATION) throw unsupported(`more than ${MAX_ENUMERATION} xs:enumeration values`);
      enumeration.push(value);
    } else if (child.local === 'pattern') patterns.push(pattern(value));
    else if (['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'].includes(child.local)) {
      const number = Number(value);
      if (value.trim() === '' || !Number.isFinite(number)) throw invalid(`xs:${child.local} "${value.slice(0, 40)}" is not a number`);
      bounds[child.local] = number;
    } else if (UNSUPPORTED_RESTRICTIONS.includes(child.local)) throw unsupported(`xs:${child.local} (planned for IDS V2)`);
    else throw invalid(`unknown restriction xs:${child.local}`);
  }
  return {
    ...(enumeration.length === 0 ? {} : { enumeration }),
    ...(patterns.length === 0 ? {} : { patterns }),
    ...(Object.keys(bounds).length === 0 ? {} : { bounds }),
  };
}

const cardinalityOf = (element: XmlElement): Cardinality => {
  const value = xmlAttr(element, 'cardinality') ?? 'required';
  if (value !== 'required' && value !== 'optional' && value !== 'prohibited')
    throw invalid(`cardinality "${value.slice(0, 20)}" is not required, optional or prohibited`);
  return value;
};

const required = (rule: ValueRule | undefined, what: string): ValueRule => {
  if (rule === undefined) throw invalid(`a facet lacks its ${what}`);
  return rule;
};

function entityFacet(element: XmlElement): EntityFacet {
  const predefinedType = valueRule(xmlChildren(element, 'predefinedType')[0]);
  return {
    type: 'entity',
    name: required(valueRule(xmlChildren(element, 'name')[0]), 'name'),
    ...(predefinedType === undefined ? {} : { predefinedType }),
  };
}

function facet(element: XmlElement): Facet {
  const child = (name: string): ValueRule | undefined => valueRule(xmlChildren(element, name)[0]);
  switch (element.local) {
    case 'entity':
      return entityFacet(element);
    case 'attribute': {
      const value = child('value');
      return {
        type: 'attribute',
        name: required(child('name'), 'name'),
        ...(value === undefined ? {} : { value }),
        cardinality: cardinalityOf(element),
      };
    }
    case 'property': {
      const value = child('value');
      const dataType = xmlAttr(element, 'dataType');
      return {
        type: 'property',
        propertySet: required(child('propertySet'), 'propertySet'),
        baseName: required(child('baseName'), 'baseName'),
        ...(value === undefined ? {} : { value }),
        ...(dataType === undefined ? {} : { dataType: dataType.toUpperCase() }),
        cardinality: cardinalityOf(element),
      };
    }
    case 'classification': {
      const system = child('system');
      const value = child('value');
      return {
        type: 'classification',
        ...(system === undefined ? {} : { system }),
        ...(value === undefined ? {} : { value }),
        cardinality: cardinalityOf(element),
      };
    }
    case 'partOf': {
      const entity = xmlChildren(element, 'entity')[0];
      if (entity === undefined) throw invalid('a partOf facet needs an <entity>');
      const relation = xmlAttr(element, 'relation');
      return {
        type: 'partOf',
        ...(relation === undefined ? {} : { relation: relation.toUpperCase() }),
        entity: entityFacet(entity),
        cardinality: cardinalityOf(element),
      };
    }
    default:
      throw unsupported(`the ${element.local} facet (supported: entity, attribute, property, classification, partOf)`);
  }
}

function facets(container: XmlElement | undefined): Facet[] {
  const found = (container?.children ?? []).flatMap((node) => (node.type === 'element' ? [node] : []));
  if (found.length > MAX_FACETS) throw unsupported(`more than ${MAX_FACETS} facets in one specification`);
  return found.map(facet);
}

function specification(element: XmlElement): Specification {
  const applicability = xmlChildren(element, 'applicability')[0];
  if (applicability === undefined) throw invalid(`specification "${xmlAttr(element, 'name') ?? ''}" has no <applicability>`);
  const minOccurs = Number(xmlAttr(applicability, 'minOccurs') ?? '1');
  return {
    name: xmlAttr(element, 'name') ?? '',
    ifcVersions: (xmlAttr(element, 'ifcVersion') ?? '').split(/\s+/).filter((version) => version !== ''),
    minOccurs: Number.isFinite(minOccurs) ? minOccurs : 1,
    applicability: facets(applicability),
    requirements: facets(xmlChildren(element, 'requirements')[0]),
  };
}

/** Parses the IDS text. @failure not XML, not an IDS document, unknown restriction, unsupported facet or pattern -> { ok: false, code, message } */
export function parseIds(text: string): IdsParse {
  const parsed = readXml(text, { maxChars: 8_000_000, maxDepth: 32, maxElements: 500_000 });
  if (!parsed.ok)
    return { ok: false, code: 'DAT_IDS_PARSE', message: `${parsed.error.code} at line ${parsed.error.line}: ${parsed.error.message}` };
  try {
    if (parsed.root.local !== 'ids') throw invalid(`the root element is <${parsed.root.local}>, not <ids>`);
    const container = xmlChildren(parsed.root, 'specifications')[0];
    const elements = xmlChildren(container ?? parsed.root, 'specification');
    if (elements.length === 0) throw invalid('the IDS has no <specification>');
    if (elements.length > MAX_SPECIFICATIONS) throw unsupported(`more than ${MAX_SPECIFICATIONS} specifications`);
    const info = xmlChildren(parsed.root, 'info')[0];
    const title = info === undefined ? '' : xmlText(xmlChildren(info, 'title')[0] ?? info).trim();
    return { ok: true, ids: { title, specifications: elements.map(specification) } };
  } catch (error) {
    if (error instanceof IdsFailure) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
