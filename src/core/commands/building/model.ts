/**
 * Shared helpers for the building (AEC/BIM) commands.
 * @layer core/commands/building
 */

import type { CadDocument, DocumentUnit, Vec2 } from '../../model/types';
import type {
  BimCategory,
  BuildingElement,
  BuildingLevel,
  BuildingModel,
} from '../../model/building';
import { createEmptyBuilding } from '../../model/building';
import type { CommandResult } from '../types';

export const METRES_PER_UNIT: Readonly<Record<DocumentUnit, number>> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

/** Converts a length given in millimetres into the document's units. */
export function fromMm(doc: Pick<CadDocument, 'units'>, millimetres: number): number {
  return (millimetres * 0.001) / METRES_PER_UNIT[doc.units];
}

/** Converts a length in document units to metres. */
export function toMetres(doc: Pick<CadDocument, 'units'>, value: number): number {
  return value * METRES_PER_UNIT[doc.units];
}

export function getBuilding(doc: Pick<CadDocument, 'building'>): BuildingModel {
  return doc.building ?? createEmptyBuilding();
}

export function noChange(doc: CadDocument, summary: string): CommandResult {
  return { document: doc, summary, affected: [] };
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isVec2(value: unknown): value is Vec2 {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1])
  );
}

export function toVec2(value: Vec2): Vec2 {
  return [value[0], value[1]];
}

export function isVec2List(value: unknown, minimumLength: number): value is Vec2[] {
  return Array.isArray(value) && value.length >= minimumLength && value.every(isVec2);
}

const MARK_PREFIX: Readonly<Record<Exclude<BimCategory, 'grid' | 'room'>, string>> = {
  wall: 'W',
  door: 'D',
  window: 'WN',
  slab: 'SL',
  column: 'C',
  beam: 'B',
  stair: 'ST',
};

/** Largest integer N among keys "<prefix>N" (0 when none). */
export function highestIndex(keys: ReadonlyArray<string>, prefix: string): number {
  let highest = 0;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const index = Number(key.slice(prefix.length));
    if (Number.isInteger(index) && index > highest) highest = index;
  }
  return highest;
}

/** Deterministic readable element id, e.g. "wall-3". */
export function nextElementId(building: BuildingModel, category: BimCategory): string {
  return `${category}-${highestIndex(Object.keys(building.elements), `${category}-`) + 1}`;
}

/** Next schedule mark for a category, e.g. "W3", "D2". */
export function nextMark(
  building: BuildingModel,
  category: Exclude<BimCategory, 'grid' | 'room'>,
): string {
  const prefix = MARK_PREFIX[category];
  const marks = Object.values(building.elements)
    .filter((element) => element.category === category)
    .map((element) => element.mark);
  return `${prefix}${highestIndex(marks, prefix) + 1}`;
}

export function nextLevelId(building: BuildingModel): string {
  return `level-${highestIndex(Object.keys(building.levels), 'level-') + 1}`;
}

export function sortLevelOrder(levels: Record<string, BuildingLevel>): string[] {
  return Object.values(levels)
    .sort((a, b) => a.elevation - b.elevation)
    .map((level) => level.id);
}

export type LevelResolution =
  | { readonly ok: true; readonly building: BuildingModel; readonly level: BuildingLevel }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the target level: explicit id → active level → lowest level → a new
 * "Level 0" (elevation 0, height 3 m) created on the fly.
 * @failure unknown explicit levelId -> ok:false
 */
export function resolveLevel(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string | undefined,
): LevelResolution {
  if (levelId !== undefined) {
    const level = building.levels[levelId];
    if (!level) {
      const known = building.levelOrder.join(', ') || 'none';
      return { ok: false, reason: `unknown level '${levelId}' (levels: ${known})` };
    }
    return { ok: true, building, level };
  }
  const fallbackId = building.activeLevelId ?? building.levelOrder[0];
  const fallback = fallbackId !== undefined ? building.levels[fallbackId] : undefined;
  if (fallback) return { ok: true, building, level: fallback };
  const level: BuildingLevel = {
    id: nextLevelId(building),
    name: 'Level 0',
    elevation: 0,
    height: fromMm(doc, 3000),
  };
  const levels = { ...building.levels, [level.id]: level };
  return {
    ok: true,
    level,
    building: {
      ...building,
      levels,
      levelOrder: sortLevelOrder(levels),
      activeLevelId: level.id,
    },
  };
}

/** Returns a building with `element` inserted (or replaced) by id. */
export function withElement(building: BuildingModel, element: BuildingElement): BuildingModel {
  const exists = building.elements[element.id] !== undefined;
  return {
    ...building,
    elements: { ...building.elements, [element.id]: element },
    elementOrder: exists ? building.elementOrder : [...building.elementOrder, element.id],
  };
}

export function lengthOf(start: Vec2, end: Vec2): number {
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

/** ASCII file-name slug ("Rez-de-chaussée" → "Rez-de-chaussee"). */
export function fileSlug(text: string, fallback: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? fallback : slug;
}
