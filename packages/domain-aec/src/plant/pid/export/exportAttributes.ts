/** `GenericAttributes` of an exported item: the stored attributes plus the typed fields that DEXPI keeps as attributes (tag, DN, class, ...), in a fixed order. */

import type { PidItem, PidValue } from '../model';
import { KNOWN_UNITS } from '../dexpi/proteusClasses';
import { positiveInt, tagOf } from '../dexpi/proteusContext';
import { el, num, type XNode } from './xmlWrite';

/** llull's own names for values it derived from a field (they are written under the DEXPI name, never twice). */
const DEFAULT_MARKERS = new Set(['nominalDiameter', 'pipingClass']);
const DN_NUMBER = 'NominalDiameterNumericalValueRepresentationAssignmentClass';
const DN_TEXT = 'NominalDiameterRepresentationAssignmentClass';

/** Unit texts people type -> the DEXPI unit name the importer reads as a quantity (anything else is written as given and comes back as unverified text). */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  bar: 'Bar',
  pa: 'Pascal',
  kpa: 'KiloPascal',
  mpa: 'MegaPascal',
  c: 'DegreeCelsius',
  '°c': 'DegreeCelsius',
  degc: 'DegreeCelsius',
  k: 'Kelvin',
  '%': 'Percent',
  w: 'Watt',
  kw: 'Kilowatt',
  kg: 'Kilogram',
  m2: 'SquareMetre',
  m3: 'CubicMetre',
  l: 'Litre',
  mm: 'Millimetre',
  cm: 'Centimetre',
  m: 'Metre',
  'm3/h': 'CubicMetrePerHour',
  hz: 'Hertz',
  s: 'Second',
  min: 'Minute',
  h: 'Hour',
  n: 'Newton',
  j: 'Joule',
  kj: 'Kilojoule',
};

export const unitName = (unit: string): string => (KNOWN_UNITS.has(unit) ? unit : (UNIT_ALIASES[unit.toLowerCase()] ?? unit));

/** The text values of an attribute map, as the importer's readers see them. */
const rawOf = (entries: ReadonlyMap<string, PidValue>): Map<string, string> =>
  new Map([...entries].map(([name, value]) => [name, value.kind === 'quantity' ? num(value.value) : value.value]));

export interface AttributeFields {
  /** DEXPI attribute name -> the value the item's typed field says (written unless the existing attribute already says it). */
  readonly set?: Readonly<Record<string, string | undefined>>;
  /** The item's tag: written as `name` unless the attributes already give it (`derive` is the importer's rule). */
  readonly tag?: { readonly name: string; readonly derive: (raw: ReadonlyMap<string, string>) => string | undefined } | undefined;
  readonly dn?: number | undefined;
  /** DEXPI names never written (stored by llull only). */
  readonly drop?: readonly string[];
  /** Passthrough overrides: `Set:Name` -> value, `null` removes. */
  readonly pass?: Readonly<Record<string, string | null>>;
}

function valueNode(name: string, value: PidValue): XNode {
  const uri = /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? `http://sandbox.dexpi.org/rdl/${name}` : undefined;
  switch (value.kind) {
    case 'quantity':
      return el('GenericAttribute', [
        ['Name', name],
        ['AttributeURI', uri],
        ['Format', 'double'],
        ['Value', num(value.value)],
        ['Units', unitName(value.unit)],
      ]);
    case 'enum':
      return el('GenericAttribute', [
        ['Name', name],
        ['AttributeURI', uri],
        ['Format', 'anyURI'],
        ['Value', value.value],
        ['ValueURI', value.uri],
      ]);
    case 'text':
      return el('GenericAttribute', [
        ['Name', name],
        ['AttributeURI', uri],
        ['Format', 'string'],
        ['Value', value.value],
      ]);
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function groupSets(items: ReadonlyArray<readonly [string, XNode]>): XNode[] {
  const bySet = new Map<string, XNode[]>();
  for (const [set, node] of items) bySet.set(set, [...(bySet.get(set) ?? []), node]);
  return [...bySet]
    .sort(([a], [b]) => (a === 'DexpiAttributes' ? -1 : b === 'DexpiAttributes' ? 1 : compare(a, b)))
    .map(([set, nodes]) =>
      el(
        'GenericAttributes',
        [
          ['Set', set],
          ['Number', String(nodes.length)],
        ],
        nodes,
      ),
    );
}

/** The `GenericAttributes` elements of an item; `only` keeps the names it accepts (`Set:Name` for passthrough). */
export function attributeNodes(item: PidItem, fields: AttributeFields = {}, only?: (name: string) => boolean): XNode[] {
  const entries = new Map<string, PidValue>();
  const drop = new Set(fields.drop ?? []);
  const named = Object.entries(item.attributes).map(([key, value]) => [key.startsWith('attr:') ? key.slice(5) : key, value] as const);
  const hasText = named.some(([name]) => name === DN_TEXT);
  for (const [name, value] of named) {
    if (drop.has(name) || (value.kind !== 'enum' && value.defaulted === true && DEFAULT_MARKERS.has(name))) continue;
    if (name === 'nominalDiameterText') {
      if (!hasText) entries.set(DN_TEXT, value);
      continue;
    }
    entries.set(name, value);
  }
  for (const [name, text] of Object.entries(fields.set ?? {})) {
    if (text === undefined) continue;
    const existing = entries.get(name);
    if (existing === undefined || existing.kind === 'quantity' || existing.value !== text) entries.set(name, { kind: 'text', value: text });
  }
  if (fields.dn !== undefined) {
    const raw = rawOf(entries);
    const fromText = /\bDN\s*(\d+)/i.exec(raw.get(DN_TEXT) ?? '')?.[1];
    if (positiveInt(raw.get(DN_NUMBER)) !== fields.dn && positiveInt(fromText) !== fields.dn)
      entries.set(DN_NUMBER, { kind: 'text', value: String(fields.dn) });
  }
  if (fields.tag !== undefined && item.tag !== undefined && fields.tag.derive(rawOf(entries)) !== item.tag)
    entries.set(fields.tag.name, { kind: 'text', value: item.tag });
  const pass = new Map(Object.entries(item.passthrough ?? {}).filter(([key]) => !key.startsWith('dexpi:')));
  for (const [key, value] of Object.entries(fields.pass ?? {})) {
    if (value === null) pass.delete(key);
    else pass.set(key, value);
  }
  const list: Array<readonly [string, XNode]> = [...entries]
    .filter(([name]) => only === undefined || only(name))
    .sort(([a], [b]) => compare(a, b))
    .map(([name, value]) => ['DexpiAttributes', valueNode(name, value)] as const);
  for (const [key, value] of [...pass].sort(([a], [b]) => compare(a, b))) {
    const colon = key.indexOf(':');
    const set = colon > 0 ? key.slice(0, colon) : 'Passthrough';
    const name = colon > 0 ? key.slice(colon + 1) : key;
    if (name !== '' && (only === undefined || only(key))) list.push([set, valueNode(name, { kind: 'text', value })] as const);
  }
  return groupSets(list);
}

/** The importer's tag rule for equipment and components (`TagNameAssignmentClass`, else prefix + sequence + suffix). */
export const equipmentTag = {
  name: 'TagNameAssignmentClass',
  derive: (raw: ReadonlyMap<string, string>): string | undefined => tagOf({ attributes: {}, passthrough: {}, raw: new Map(raw) }),
};
