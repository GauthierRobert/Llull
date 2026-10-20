/**
 * Reads the composite records `appendComposite` writes (06 CMP §6.4 V2, M5) out of an ISO 10303-21 text with the independent Part 21 record reader,
 * without OpenCascade. Only the llull composite encoding is understood; a file from another system without it answers `no_composite`.
 * @invariant pure; never throws; values are exactly the numbers in the file (document units, degrees)
 */

import type { LaminaMaterial, PlyBoundary, PlyCut, PlyDrape } from '@core/model/composites';
import type { DocumentUnit, Vec2, Vec3 } from '@core/model/types';
import { entityName, parseRecords, referencesOf, stringsOf } from '@lib/step21/records';
import type { CompositeRecord, PlyRecord, RosetteRecord } from './interchange';
import { unquoted } from './part21';
import { ENCODING, LEGACY_ENCODING, PROPERTY } from './writer';
import { readStandard, type StandardRead } from './standardReader';

/** The validation properties the file carries; a missing one is absent (not checkable). */
export interface EmbeddedValidation {
  readonly plyCount?: number;
  readonly thickness?: number;
  readonly mass?: number;
  readonly plyAreas: Readonly<Record<string, number>>;
}

export type ReadOutcome =
  | {
      readonly ok: true;
      readonly record: Omit<CompositeRecord, 'validation'>;
      readonly embedded: EmbeddedValidation;
      /** Plies whose explicit solids are linked from the solids' own products (names), as written on the solid side. */
      readonly linkedSolids: Readonly<Record<string, readonly string[]>>;
      readonly laminates: number;
      /** The CAx-IF structure of the file (absent in files of the first encoding). */
      readonly standard: StandardRead;
    }
  | { readonly ok: false; readonly code: 'no_composite' | 'malformed'; readonly reason: string };

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?`;

interface Item {
  readonly kind: string;
  readonly name: string;
  readonly text?: string;
  readonly number?: number;
  readonly numbers?: readonly number[];
  readonly points?: readonly (readonly number[])[];
}

type Bodies = ReadonlyMap<number, string>;

const numbersOf = (body: string): number[] => {
  const list = /\(\s*((?:[-+]?[\d.]+(?:[Ee][-+]?\d+)?\s*,?\s*)+)\)\s*\)?$/.exec(body)?.[1];
  return list === undefined ? [] : (list.match(new RegExp(NUMBER, 'g')) ?? []).map(Number);
};

function itemOf(bodies: Bodies, id: number): Item | null {
  const body = bodies.get(id);
  if (body === undefined) return null;
  const kind = entityName(body);
  const strings = stringsOf(body).map(unquoted);
  const name = strings[0] ?? '';
  if (kind === 'DESCRIPTIVE_REPRESENTATION_ITEM') return { kind, name, text: strings[1] ?? '' };
  if (kind === 'VALUE_REPRESENTATION_ITEM' || kind === 'MEASURE_REPRESENTATION_ITEM') {
    const match = new RegExp(String.raw`,\s*[A-Z_]+\(\s*(${NUMBER})\s*\)`).exec(body);
    return match?.[1] === undefined ? null : { kind, name, number: Number(match[1]) };
  }
  if (kind === 'CARTESIAN_POINT' || kind === 'DIRECTION') return { kind, name, numbers: numbersOf(body) };
  if (kind === 'POLYLINE') {
    const points = referencesOf(body).map((reference) => numbersOf(bodies.get(reference) ?? ''));
    return { kind, name, points };
  }
  return null;
}

/** Items of the representation attached to each PROPERTY_DEFINITION, keyed by the definition. */
function propertiesOf(bodies: Bodies): { name: string; description: string; target: number; items: Item[] }[] {
  const representations = new Map<number, number>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PROPERTY_DEFINITION_REPRESENTATION') continue;
    const [definition, representation] = referencesOf(body);
    if (definition !== undefined && representation !== undefined) representations.set(definition, representation);
  }
  const found: { name: string; description: string; target: number; items: Item[] }[] = [];
  const known = new Set<string>(Object.values(PROPERTY));
  for (const [id, body] of [...bodies].sort(([a], [b]) => a - b)) {
    if (entityName(body) !== 'PROPERTY_DEFINITION') continue;
    const [name = '', description = ''] = stringsOf(body).map(unquoted);
    const target = referencesOf(body)[0];
    const representation = representations.get(id);
    if (!known.has(name) || target === undefined || representation === undefined) continue;
    const references = referencesOf(bodies.get(representation) ?? '');
    const items = references.slice(0, -1).flatMap((reference) => itemOf(bodies, reference) ?? []);
    found.push({ name, description, target, items });
  }
  return found;
}

const textOf = (items: readonly Item[], name: string): string | undefined =>
  items.find((item) => item.name === name && item.text !== undefined)?.text;
const numberOf = (items: readonly Item[], name: string): number | undefined => items.find((item) => item.name === name)?.number;

function parseJson<T>(text: string | undefined): T | null {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const isVec3 = (value: readonly number[] | undefined): value is Vec3 =>
  value !== undefined && value.length === 3 && value.every((entry) => Number.isFinite(entry));

/** Product names (of the PRODUCT_DEFINITION a property hangs on), for the piece links. */
function productNameOf(bodies: Bodies, definition: number): string | null {
  const formation = referencesOf(bodies.get(definition) ?? '')[0];
  const product = formation === undefined ? undefined : referencesOf(bodies.get(formation) ?? '')[0];
  const body = product === undefined ? undefined : bodies.get(product);
  if (body === undefined) return null;
  const [id = '', name = ''] = stringsOf(body).map(unquoted);
  return name !== '' ? name : id;
}

function plyOf(items: readonly Item[]): PlyRecord | string {
  const name = textOf(items, 'name');
  const material = textOf(items, 'material');
  const orientation = numberOf(items, 'orientation');
  const thickness = numberOf(items, 'thickness');
  const area = numberOf(items, 'area');
  const order = numberOf(items, 'order');
  if (
    name === undefined ||
    material === undefined ||
    orientation === undefined ||
    thickness === undefined ||
    area === undefined ||
    order === undefined
  )
    return `a ply record lacks name, material, order, orientation, thickness or area (ply "${name ?? '?'}")`;
  const polygons = items
    .filter((item) => item.kind === 'POLYLINE' && /^ply boundary \d+$/.test(item.name))
    .map((item) => (item.points ?? []).map((point): Vec2 => [point[0] ?? 0, point[1] ?? 0]));
  const boundary: PlyBoundary = textOf(items, 'boundary') === 'polygons' ? { kind: 'polygons', polygons } : { kind: 'whole_face' };
  if (boundary.kind === 'polygons' && (polygons.length === 0 || polygons.some((polygon) => polygon.length < 3)))
    return `ply "${name}" has a degenerate boundary`;
  const data = parseJson<{ drape?: PlyDrape; cuts?: PlyCut[]; solids?: string[] }>(textOf(items, 'data')) ?? {};
  return {
    name,
    sequence: textOf(items, 'sequence') ?? '',
    order,
    material,
    orientation,
    rosette: textOf(items, 'rosette') ?? '',
    boundary,
    ...(data.drape === undefined ? {} : { drape: data.drape }),
    ...(data.cuts === undefined ? {} : { cuts: data.cuts }),
    thickness,
    area,
    solids: data.solids ?? [],
  };
}

/** The composite content of `text`. */
export function readComposite(text: string): ReadOutcome {
  const { bodies } = parseRecords(text);
  const properties = propertiesOf(bodies);
  const laminates = properties.filter((entry) => entry.name === PROPERTY.laminate);
  const laminate = laminates[0];
  if (laminate === undefined) return { ok: false, code: 'no_composite', reason: 'the file has no composite laminate record' };
  const { items } = laminate;
  const encoding = textOf(items, 'encoding');
  if (encoding !== ENCODING && encoding !== LEGACY_ENCODING)
    return {
      ok: false,
      code: 'malformed',
      reason: `unknown composite encoding "${textOf(items, 'encoding') ?? ''}" (expected ${ENCODING})`,
    };
  const data = parseJson<{
    surface?: CompositeRecord['surface'];
    outline?: Vec2[];
    rules?: CompositeRecord['rules'];
    plyDropRules?: CompositeRecord['plyDropRules'];
    tool?: CompositeRecord['tool'];
  }>(textOf(items, 'data'));
  const side = textOf(items, 'laminate side');
  const unit = textOf(items, 'unit');
  const toolName = textOf(items, 'tool');
  const face = items.find((item) => item.name === 'tool face near')?.numbers;
  if (
    data?.surface === undefined ||
    data.outline === undefined ||
    (side !== 'positive_normal' && side !== 'negative_normal') ||
    !['mm', 'cm', 'm', 'in', 'ft'].includes(unit ?? '') ||
    toolName === undefined ||
    !isVec3(face)
  )
    return { ok: false, code: 'malformed', reason: 'the laminate record lacks its surface, outline, side, unit, tool or tool face point' };
  const rosettes: RosetteRecord[] = [];
  for (const entry of properties.filter((property) => property.name === PROPERTY.rosette)) {
    const find = (name: string): readonly number[] | undefined => entry.items.find((item) => item.name === name)?.numbers;
    const [origin, axis0, normal, axis] = [find('origin'), find('axis0'), find('normal'), find('axis')];
    const method = textOf(entry.items, 'method');
    const name = textOf(entry.items, 'name');
    if (!isVec3(origin) || !isVec3(axis0) || !isVec3(normal) || name === undefined || method === undefined)
      return { ok: false, code: 'malformed', reason: `rosette record "${entry.description}" is incomplete` };
    rosettes.push({
      name,
      origin: origin,
      axis0: axis0,
      normal: normal,
      method: method as RosetteRecord['method'],
      ...(isVec3(axis) ? { axis } : {}),
    });
  }
  const materials: LaminaMaterial[] = [];
  for (const entry of properties.filter((property) => property.name === PROPERTY.material)) {
    const material = parseJson<LaminaMaterial>(textOf(entry.items, 'data'));
    if (material === null || typeof material.name !== 'string')
      return { ok: false, code: 'malformed', reason: `material record "${entry.description}" is unreadable` };
    materials.push(material);
  }
  const plies: PlyRecord[] = [];
  for (const entry of properties.filter((property) => property.name === PROPERTY.ply)) {
    const ply = plyOf(entry.items);
    if (typeof ply === 'string') return { ok: false, code: 'malformed', reason: ply };
    plies.push(ply);
  }
  const plyAreas: Record<string, number> = {};
  let plyCount: number | undefined;
  let thickness: number | undefined;
  let mass: number | undefined;
  for (const entry of properties.filter(
    (property) => property.name === (encoding === LEGACY_ENCODING ? PROPERTY.validation : PROPERTY.extension),
  )) {
    if (entry.description === 'ply area') {
      const ply = textOf(entry.items, 'ply');
      const area = numberOf(entry.items, 'ply area');
      if (ply !== undefined && area !== undefined) plyAreas[ply] = area;
    } else {
      plyCount = numberOf(entry.items, 'number of plies') ?? plyCount;
      thickness = numberOf(entry.items, 'laminate thickness') ?? thickness;
      mass = numberOf(entry.items, 'laminate mass') ?? mass;
    }
  }
  const linkedSolids: Record<string, string[]> = {};
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PROPERTY_DEFINITION' || unquoted(stringsOf(body)[0] ?? '') !== PROPERTY.piece) continue;
    const ply = unquoted(stringsOf(body)[1] ?? '');
    const product = productNameOf(bodies, referencesOf(body)[0] ?? 0);
    if (product !== null) linkedSolids[ply] = [...(linkedSolids[ply] ?? []), product];
  }
  const record: Omit<CompositeRecord, 'validation'> = {
    name: textOf(items, 'name') ?? laminate.description,
    units: unit as DocumentUnit,
    laminateSide: side,
    tool: { ...(data.tool ?? { entityId: '', faceNear: face }), name: toolName, faceNear: face },
    partRosette: textOf(items, 'part rosette') ?? '',
    rosettes,
    surface: data.surface,
    outline: data.outline,
    ...(data.rules === undefined ? {} : { rules: data.rules }),
    ...(data.plyDropRules === undefined ? {} : { plyDropRules: data.plyDropRules }),
    materials,
    plies,
  };
  return {
    ok: true,
    record,
    embedded: {
      ...(plyCount === undefined ? {} : { plyCount }),
      ...(thickness === undefined ? {} : { thickness }),
      ...(mass === undefined ? {} : { mass }),
      plyAreas,
    },
    linkedSolids,
    laminates: laminates.length,
    standard: readStandard(text),
  };
}
