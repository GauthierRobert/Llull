/** Builders of DEXPI 2.0 elements and the conversion of Proteus `GenericAttributes` to 2.0 `Data` (plant 04 PID §6.2, §6.3). */

import { el, type XNode } from '../export/xmlWrite';
import { attributeProperty, encodeName, enumReference, unitReference } from './names20';

export const attrOf = (node: XNode, name: string): string | undefined => node.attrs.find(([key]) => key === name)?.[1];
export const childrenOf = (node: XNode, name: string): XNode[] => node.children.filter((child) => child.name === name);

/** `<Object id type>` with the given parts. */
export const object = (type: string, id: string | undefined, parts: readonly XNode[]): XNode =>
  el(
    'Object',
    [
      ['id', id],
      ['type', type],
    ],
    parts,
  );

export const components = (property: string, objects: readonly XNode[]): XNode[] =>
  objects.length === 0 ? [] : [el('Components', [['property', property]], objects)];

export const references = (property: string, ids: readonly (string | undefined)[]): XNode[] => {
  const named = ids.flatMap((id) => (id === undefined ? [] : [`#${id}`]));
  return named.length === 0
    ? []
    : [
        el('References', [
          ['objects', named.join(' ')],
          ['property', property],
        ]),
      ];
};

export const dataString = (property: string, value: string): XNode => el('Data', [['property', property]], [el('String', [], [], value)]);
export const dataTyped = (property: string, type: 'Double' | 'Boolean', value: string): XNode =>
  el('Data', [['property', property]], [el(type, [], [], value)]);
export const dataReference = (property: string, data: string): XNode =>
  el('Data', [['property', property]], [el('DataReference', [['data', data]])]);

/** A `Core/Diagram.Point` value held by `Data` of `property`. */
export const dataPoint = (property: string, x: string, y: string): XNode =>
  el(
    'Data',
    [['property', property]],
    [el('AggregatedDataValue', [['type', 'Core/Diagram.Point']], [dataTyped('X', 'Double', x), dataTyped('Y', 'Double', y)])],
  );

/** A class name as the last part of a 2.0 type. */
export const typeOf = (prefix: string, className: string): string => `${prefix}.${encodeName(className)}`;

const isDouble = (text: string): boolean => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim());

function dataOf(attribute: XNode, set: string): XNode | undefined {
  const name = attrOf(attribute, 'Name') ?? '';
  const format = attrOf(attribute, 'Format');
  const value = attrOf(attribute, 'Value') ?? '';
  const units = attrOf(attribute, 'Units');
  if (name === '') return undefined;
  if (set !== 'DexpiAttributes') return dataString(`Llull_${encodeName(`${set}:${name}`)}`, value);
  if (format === 'anyURI' && value !== '') {
    const property = attributeProperty(name, 'enum');
    return dataReference(property, enumReference(property.startsWith('Llull_') ? name : property, value, attrOf(attribute, 'ValueURI')));
  }
  if (format === 'double' && units !== undefined && isDouble(value))
    return el(
      'Data',
      [['property', attributeProperty(name, 'quantity')]],
      [
        el(
          'AggregatedDataValue',
          [['type', 'Core/PhysicalQuantities.PhysicalQuantity']],
          [dataReference('Unit', unitReference(units)), dataTyped('Value', 'Double', value.trim())],
        ),
      ],
    );
  return dataString(attributeProperty(name, 'text'), value);
}

/** The `Data` of the `GenericAttributes` of a Proteus element (properties as the 2.0 file names them; a name clash keeps the first). */
export function dataNodes(node: XNode): XNode[] {
  const seen = new Set<string>();
  const out: XNode[] = [];
  for (const set of childrenOf(node, 'GenericAttributes'))
    for (const attribute of childrenOf(set, 'GenericAttribute')) {
      const data = dataOf(attribute, attrOf(set, 'Set') ?? 'DexpiAttributes');
      const property = data === undefined ? undefined : attrOf(data, 'property');
      if (data === undefined || property === undefined || seen.has(property)) continue;
      seen.add(property);
      out.push(data);
    }
  return out;
}
