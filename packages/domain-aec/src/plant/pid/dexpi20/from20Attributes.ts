/** `Data` of a DEXPI 2.0 object -> the `GenericAttributes` the Proteus mapper reads (plant 04 PID §6.2). */

import { xmlAttr, xmlChildren, xmlText, type XmlElement } from '@lib/xmlRead';
import { attributeName, unitOfReference, valueOfReference, type ValueKind } from './names20';
import { syn } from './syn';

interface Value {
  readonly kind: ValueKind;
  readonly value: string;
  readonly unit?: string;
  readonly uri?: string;
}

/** The first `Data` of `property` below an aggregated value (`Value`, `Unit` of a physical quantity). */
const part = (aggregate: XmlElement, property: string): XmlElement | undefined =>
  xmlChildren(aggregate, 'Data').find((data) => xmlAttr(data, 'property') === property);

function valueOf(data: XmlElement): Value | undefined {
  const typed = xmlChildren(data)[0];
  if (typed === undefined) return undefined;
  switch (typed.local) {
    case 'String':
      return { kind: 'text', value: xmlText(typed) };
    case 'Double':
    case 'Integer':
    case 'Boolean':
    case 'DateTime':
      return { kind: 'text', value: xmlText(typed).trim() };
    case 'DataReference': {
      const reference = xmlAttr(typed, 'data') ?? '';
      return { kind: 'enum', value: valueOfReference(reference), uri: reference };
    }
    case 'AggregatedDataValue': {
      const unit = part(typed, 'Unit');
      const amount = part(typed, 'Value');
      const unitRef = unit === undefined ? undefined : xmlChildren(unit, 'DataReference')[0];
      const number = amount === undefined ? undefined : xmlChildren(amount)[0];
      if (unitRef !== undefined && number !== undefined)
        return { kind: 'quantity', value: xmlText(number).trim(), unit: unitOfReference(xmlAttr(unitRef, 'data') ?? '') };
      const text = findText(typed);
      return text === undefined ? undefined : { kind: 'text', value: text };
    }
    default:
      return undefined;
  }
}

/** The string of the first `Value` property below an aggregated value (a multi-language string keeps its first language). Iterative. */
function findText(root: XmlElement): string | undefined {
  const stack: XmlElement[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.local === 'Data' && xmlAttr(node, 'property') === 'Value') {
      const string = xmlChildren(node, 'String')[0];
      if (string !== undefined) return xmlText(string);
    }
    const children = xmlChildren(node);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index] as XmlElement);
  }
  return undefined;
}

/** The `GenericAttributes` elements (set DexpiAttributes first, then the other sets in order of appearance) of the `Data` of `object`. */
export function genericAttributes(object: XmlElement): XmlElement[] {
  const sets = new Map<string, XmlElement[]>();
  for (const data of xmlChildren(object, 'Data')) {
    const property = xmlAttr(data, 'property');
    const value = property === undefined ? undefined : valueOf(data);
    if (property === undefined || value === undefined) continue;
    const full = attributeName(property, value.kind);
    const colon = value.kind === 'text' ? full.indexOf(':') : -1;
    const set = colon > 0 ? full.slice(0, colon) : 'DexpiAttributes';
    const name = colon > 0 ? full.slice(colon + 1) : full;
    const attribute = syn(
      'GenericAttribute',
      [
        ['Name', name],
        ['Format', value.kind === 'enum' ? 'anyURI' : value.kind === 'quantity' ? 'double' : 'string'],
        ['Value', value.value],
        ['Units', value.unit],
        ['ValueURI', value.uri],
      ],
      [],
      data,
    );
    sets.set(set, [...(sets.get(set) ?? []), attribute]);
  }
  return [...sets]
    .sort(([a], [b]) => (a === 'DexpiAttributes' ? -1 : b === 'DexpiAttributes' ? 1 : 0))
    .map(([set, list]) => syn('GenericAttributes', [['Set', set]], list, object));
}
