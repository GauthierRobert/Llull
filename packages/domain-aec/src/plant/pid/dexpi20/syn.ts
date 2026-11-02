/** Accessors of DEXPI 2.0 objects and the builder of the Proteus-shaped tree the 2.0 reader hands to the shared mapper (plant 04 PID §6.2). */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { decodeName } from './names20';

/** Builds an element of the Proteus tree; `at` is the 2.0 element it stands for (its line and column are kept for diagnostics). */
export function syn(
  name: string,
  attrs: ReadonlyArray<readonly [string, string | undefined]>,
  children: readonly XmlElement[],
  at: XmlElement,
): XmlElement {
  return {
    type: 'element',
    name,
    prefix: '',
    local: name,
    namespace: null,
    attributes: attrs.flatMap(([key, value]) =>
      value === undefined ? [] : [{ name: key, prefix: '', local: key, namespace: null, value }],
    ),
    children,
    line: at.line,
    column: at.column,
  };
}

/** The class of an object: the part of its `type` after the last `.` (or `/`), decoded. */
export function classOf(object: XmlElement): string {
  const type = xmlAttr(object, 'type') ?? '';
  return decodeName(type.slice(Math.max(type.lastIndexOf('.'), type.lastIndexOf('/')) + 1));
}

/** The id of an object as the Proteus tree writes it (decoded), or undefined. */
export const idOf = (object: XmlElement): string | undefined => {
  const id = xmlAttr(object, 'id');
  return id === undefined || id === '' ? undefined : decodeName(id);
};

/** Objects held by the `Components` of `property` (all properties when absent), in order. */
export function componentObjects(object: XmlElement, property?: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const components of xmlChildren(object, 'Components'))
    if (property === undefined || xmlAttr(components, 'property') === property) found.push(...xmlChildren(components, 'Object'));
  return found;
}

/** Ids a `References` of `property` names (`#a #b` -> `a`, `b`), decoded. */
export function referenceIds(object: XmlElement, property: string): string[] {
  const ids: string[] = [];
  for (const references of xmlChildren(object, 'References'))
    if (xmlAttr(references, 'property') === property)
      for (const part of (xmlAttr(references, 'objects') ?? '').split(' '))
        if (part.startsWith('#') && part.length > 1) ids.push(decodeName(part.slice(1)));
  return ids;
}

/** The `Data` of `property`, if any. */
export const dataOf = (object: XmlElement, property: string): XmlElement | undefined =>
  xmlChildren(object, 'Data').find((data) => xmlAttr(data, 'property') === property);

export const association = (type: string, itemId: string, at: XmlElement): XmlElement =>
  syn(
    'Association',
    [
      ['Type', type],
      ['ItemID', itemId],
    ],
    [],
    at,
  );
