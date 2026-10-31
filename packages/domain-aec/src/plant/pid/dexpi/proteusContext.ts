/** Shared state and readers of the Proteus (DEXPI 1.3) mapper: the import context, positions, units, generic attributes (plant 04 PID §6.1). */

import { nextId } from '@lib/id';
import { isReservedKey } from '@lib/reservedKey';
import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import type { PidItem, PidValue } from '../model';
import { dexpiIssue, type DexpiIssue, type DexpiSeverity } from './codes';
import { KNOWN_UNITS } from './proteusClasses';

/** What a DEXPI object id stands for once its item exists. */
export type Ref =
  | { readonly type: 'nozzle'; readonly id: string }
  /** `nodePort[n]` = port index of the DEXPI node n (-1 when node n has no position, e.g. the default node). */
  | { readonly type: 'inline'; readonly id: string; readonly ports: readonly Vec2[]; readonly nodePort: readonly number[] }
  | { readonly type: 'opc'; readonly id: string }
  /** A segment (the first piece of the DEXPI segment): an information flow ends on it as a branch. */
  | { readonly type: 'segment'; readonly id: string }
  /** An instrument or an actuating system (endpoint type `instrument`). */
  | { readonly type: 'instrument'; readonly id: string }
  /** An object that stands for another one (a signal generating function for the item it sits in, an actuating function for its system). */
  | { readonly type: 'alias'; readonly target: string }
  | { readonly type: 'other' };

export interface ImportContext {
  readonly sheetId: string;
  /** Drawing unit -> mm. */
  readonly scale: number;
  readonly items: Record<string, PidItem>;
  readonly order: string[];
  readonly refs: Map<string, Ref>;
  /** Every `ID` of the instance part of the file (the census rule for dangling references). */
  readonly allIds: ReadonlySet<string>;
  readonly issues: DexpiIssue[];
  /** Presentation elements not reproduced: element name -> count. */
  readonly dropped: Map<string, number>;
  readonly unitsSeen: Set<string>;
}

export function addItem(ctx: ImportContext, item: PidItem): void {
  ctx.items[item.id] = item;
  ctx.order.push(item.id);
}

export const mintId = (): string => nextId('pid');

export const where = (el: XmlElement): string => `line ${el.line}, column ${el.column}`;

export function warn(
  ctx: ImportContext,
  code: string,
  severity: DexpiSeverity,
  message: string,
  el?: XmlElement,
  ids: readonly string[] = [],
): void {
  ctx.issues.push(dexpiIssue(code, severity, message, ids, el === undefined ? [] : [where(el)]));
}

export function drop(ctx: ImportContext, element: XmlElement): void {
  ctx.dropped.set(element.local, (ctx.dropped.get(element.local) ?? 0) + 1);
}

const GRAPHICS = new Set(['Label', 'PolyLine', 'Shape', 'Text', 'Symbol', 'PipeSlopeSymbol', 'Drawing', 'ShapeCatalogue']);

/** Counts the presentation children of `el` as dropped. */
export function dropGraphics(ctx: ImportContext, el: XmlElement): void {
  for (const child of xmlChildren(el)) if (GRAPHICS.has(child.local)) drop(ctx, child);
}

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

export function toNumber(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The point of an element with `X` / `Y` attributes (Location, Coordinate), in mm. */
export function pointOf(ctx: ImportContext, el: XmlElement | undefined): Vec2 | undefined {
  if (el === undefined) return undefined;
  const x = toNumber(xmlAttr(el, 'X'));
  const y = toNumber(xmlAttr(el, 'Y'));
  return x === undefined || y === undefined ? undefined : [round(x * ctx.scale), round(y * ctx.scale)];
}

/** The `Coordinate` points of one `CenterLine`, in order (mm). */
export function lineCoordinates(ctx: ImportContext, line: XmlElement): Vec2[] {
  const points: Vec2[] = [];
  for (const coordinate of xmlChildren(line, 'Coordinate')) {
    const point = pointOf(ctx, coordinate);
    if (point !== undefined) points.push(point);
  }
  return points;
}

/** The points of all `CenterLine` children of `el`, in order (mm). */
export function centerLinePoints(ctx: ImportContext, el: XmlElement): Vec2[] {
  const points: Vec2[] = [];
  for (const line of xmlChildren(el, 'CenterLine')) points.push(...lineCoordinates(ctx, line));
  return points;
}

/** `<Position><Location/><Reference/></Position>`: sheet position in mm and rotation (angle of the Reference axis, degrees CCW). */
export function placement(ctx: ImportContext, el: XmlElement): { at: Vec2 | undefined; rotationDeg: number } {
  const position = xmlChildren(el, 'Position')[0];
  const at = position === undefined ? undefined : pointOf(ctx, xmlChildren(position, 'Location')[0]);
  const reference = position === undefined ? undefined : xmlChildren(position, 'Reference')[0];
  const rx = toNumber(reference === undefined ? undefined : xmlAttr(reference, 'X'));
  const ry = toNumber(reference === undefined ? undefined : xmlAttr(reference, 'Y'));
  const angle = rx === undefined || ry === undefined || (rx === 0 && ry === 0) ? 0 : (Math.atan2(ry, rx) * 180) / Math.PI;
  return { at, rotationDeg: round(angle) };
}

/** Nodes with a position, in node order, and the DEXPI node index -> port index map. */
export function portsOf(ctx: ImportContext, el: XmlElement): { ports: Vec2[]; nodePort: number[] } {
  const ports: Vec2[] = [];
  const nodePort: number[] = [];
  for (const points of xmlChildren(el, 'ConnectionPoints'))
    for (const node of xmlChildren(points, 'Node')) {
      const position = xmlChildren(node, 'Position')[0];
      const at = position === undefined ? undefined : pointOf(ctx, xmlChildren(position, 'Location')[0]);
      nodePort.push(at === undefined ? -1 : ports.length);
      if (at !== undefined) ports.push(at);
    }
  return { ports, nodePort };
}

export interface ReadAttributes {
  readonly attributes: Record<string, PidValue>;
  readonly passthrough: Record<string, string>;
  /** name -> the `Value` string of the DexpiAttributes set. */
  readonly raw: Map<string, string>;
}

const safeKey = (name: string): string => (isReservedKey(name) ? `attr:${name}` : name);

function valueOf(ctx: ImportContext, attribute: XmlElement, name: string): PidValue {
  const value = xmlAttr(attribute, 'Value') ?? '';
  const format = xmlAttr(attribute, 'Format');
  if (format === 'anyURI') {
    const uri = xmlAttr(attribute, 'ValueURI');
    return uri === undefined ? { kind: 'enum', value } : { kind: 'enum', value, uri };
  }
  const unit = xmlAttr(attribute, 'Units');
  if (format === 'double' && unit !== undefined) {
    const parsed = toNumber(value);
    if (parsed !== undefined && KNOWN_UNITS.has(unit)) return { kind: 'quantity', value: parsed, unit };
    if (parsed === undefined || !ctx.unitsSeen.has(unit)) {
      ctx.unitsSeen.add(unit);
      const why = parsed === undefined ? `value "${value}" is not a number` : `unit ${unit} is not known`;
      warn(ctx, 'DEXPI_ATTRIBUTE_UNIT', 'warning', `attribute ${name}: ${why}; kept as text, unverified`, attribute);
    }
    return { kind: 'text', value: `${value} ${unit}`.trim(), unverified: true };
  }
  return { kind: 'text', value };
}

/** The `GenericAttributes` of an element: set DexpiAttributes -> typed `attributes`, any other set -> `passthrough` (`<Set>:<Name>`). */
export function readAttributes(ctx: ImportContext, el: XmlElement): ReadAttributes {
  const attributes: Record<string, PidValue> = {};
  const passthrough: Record<string, string> = {};
  const raw = new Map<string, string>();
  for (const set of xmlChildren(el, 'GenericAttributes')) {
    const setName = xmlAttr(set, 'Set') ?? 'DexpiAttributes';
    for (const attribute of xmlChildren(set, 'GenericAttribute')) {
      const name = xmlAttr(attribute, 'Name');
      if (name === undefined || name === '') continue;
      if (setName === 'DexpiAttributes') {
        attributes[safeKey(name)] = valueOf(ctx, attribute, name);
        raw.set(name, xmlAttr(attribute, 'Value') ?? '');
      } else passthrough[safeKey(`${setName}:${name}`)] = xmlAttr(attribute, 'Value') ?? '';
    }
  }
  return { attributes, passthrough, raw };
}

export function positiveInt(text: string | undefined): number | undefined {
  const value = toNumber(text);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Nominal size DN (integer) of an element's attributes; the textual form is added to `attributes.nominalDiameterText`. */
export function diameterOf(read: ReadAttributes): number | undefined {
  const text = read.raw.get('NominalDiameterRepresentationAssignmentClass');
  if (text !== undefined) read.attributes['nominalDiameterText'] = { kind: 'text', value: text };
  return (
    positiveInt(read.raw.get('NominalDiameterNumericalValueRepresentationAssignmentClass')) ??
    positiveInt(/\bDN\s*(\d+)/i.exec(text ?? '')?.[1])
  );
}

/** Fields every item has, minus `kind`. */
export interface Base {
  id: string;
  sheetId: string;
  at: Vec2;
  rotationDeg: number;
  dexpiClass: string;
  attributes: Record<string, PidValue>;
  classUri?: string;
  tag?: string;
  passthrough?: Record<string, string>;
  sourceId?: string;
}

export function baseOf(
  ctx: ImportContext,
  el: XmlElement,
  dexpiClass: string,
  read: ReadAttributes,
  extra: { at?: Vec2 | undefined; rotationDeg?: number; tag?: string | undefined; passthrough?: Record<string, string> } = {},
): Base {
  const place = extra.at !== undefined && extra.rotationDeg !== undefined ? undefined : placement(ctx, el);
  const passthrough = { ...read.passthrough, ...extra.passthrough };
  const classUri = xmlAttr(el, 'ComponentClassURI');
  const sourceId = xmlAttr(el, 'ID');
  return {
    id: mintId(),
    sheetId: ctx.sheetId,
    at: extra.at ?? place?.at ?? [0, 0],
    rotationDeg: extra.rotationDeg ?? place?.rotationDeg ?? 0,
    dexpiClass,
    attributes: read.attributes,
    ...(classUri === undefined ? {} : { classUri }),
    ...(extra.tag === undefined ? {} : { tag: extra.tag }),
    ...(Object.keys(passthrough).length === 0 ? {} : { passthrough }),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

/** The class an element maps to: itself when known, else `Custom` with the source class kept in passthrough (DEXPI_UNMAPPED_CLASS). */
export function classify(
  ctx: ImportContext,
  el: XmlElement,
  known: ReadonlySet<string>,
): { dexpiClass: string; passthrough: Record<string, string> } {
  const source = xmlAttr(el, 'ComponentClass') ?? '';
  if (known.has(source)) return { dexpiClass: source, passthrough: {} };
  warn(ctx, 'DEXPI_UNMAPPED_CLASS', 'warning', `class "${source}" has no llull mapping; imported as Custom`, el, [xmlAttr(el, 'ID') ?? '']);
  return { dexpiClass: 'Custom', passthrough: { 'dexpi:ComponentClass': source } };
}

export function tagOf(read: ReadAttributes): string | undefined {
  const full = read.raw.get('TagNameAssignmentClass');
  if (full !== undefined && full !== '') return full;
  const prefix = read.raw.get('TagNamePrefixAssignmentClass') ?? '';
  const sequence = read.raw.get('TagNameSequenceNumberAssignmentClass') ?? '';
  const suffix = read.raw.get('TagNameSuffixAssignmentClass') ?? '';
  const composed = `${prefix}${sequence}${suffix}`;
  return composed === '' ? undefined : composed;
}

/** ItemIDs of the associations of `type` on an element. */
export function associations(el: XmlElement, type: string): string[] {
  return xmlChildren(el, 'Association')
    .flatMap((association) => (xmlAttr(association, 'Type') === type ? [xmlAttr(association, 'ItemID') ?? ''] : []))
    .filter((id) => id !== '');
}

/** Work queued by the first pass for the second (segments and flows need every item to exist before they connect). */
export interface Pending {
  readonly segments: Array<{
    readonly el: XmlElement;
    readonly lineId: string;
    readonly dn: number | undefined;
    readonly pipingClass: string | undefined;
  }>;
  readonly flows: XmlElement[];
  readonly actuating: XmlElement[];
  readonly loops: XmlElement[];
  /** PipingComponent element -> its inline ref (the element is the key: file ids may repeat). */
  readonly components: Map<XmlElement, Extract<Ref, { type: 'inline' }>>;
  /** ActuatingSystem dexpi id -> the instrument whose actuating function it fulfils. */
  readonly controllers: Map<string, string>;
}

export function register(ctx: ImportContext, el: XmlElement, ref: Ref): void {
  const id = xmlAttr(el, 'ID');
  if (id !== undefined && id !== '') ctx.refs.set(id, ref);
}
