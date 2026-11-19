/**
 * Per-part moisture state of check_space_environment (PHY-14 FR-ENV-12): each part (solid, or instanced child once per instance) with a material is
 * judged over the mission humidity exposure through `moisture_uptake` (one call per material and thickness), never a copy of the Fick numerics.
 */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import type { Budget } from './budget';
import type { EnvItem } from './codes';
import { isMissing, materialProperty } from './materialValue';
import type { Part } from './parts';
import type { HumidityExposure, Quantity } from './types';

/** A caller part thickness: `entityId` is the part (an instanced child id) or the root that names it (every child of that root). */
interface PartThickness {
  readonly entityId: string;
  readonly thickness: Quantity;
}

interface MoistureItem {
  readonly entityId: string;
  readonly rootId: string;
  readonly material: string;
  /** info: a moisture state was computed; unknown: the thickness or a material property is missing. */
  readonly status: 'info' | 'unknown';
  readonly code: string;
  readonly thickness: Quantity | null;
  /** Content after the mission exposure, % of dry mass. */
  readonly moisturePercent: number | null;
  /** Fraction of the way to the saturation, G(tau). */
  readonly fraction: number | null;
  /** Equilibrium content at the mission conditions, %. */
  readonly saturationPercent: number | null;
  readonly massG: number | null;
  /** Water taken up over the exposure (content gain x mass), grams. */
  readonly waterUptakeG: number | null;
  /** Upper bound at saturation (saturation x mass), grams; needs no thickness. */
  readonly saturationWaterG: number | null;
  readonly unverified: boolean;
  readonly message: string;
}

export interface MoistureSection {
  readonly exposure: HumidityExposure;
  readonly items: readonly MoistureItem[];
  readonly findings: readonly EnvItem[];
}

interface Uptake {
  readonly moisturePercent: number;
  readonly fraction: number;
  readonly saturationPercent: number | null;
  readonly unverified: boolean;
}

interface Refused {
  readonly code: string;
  readonly reason: string;
}

const numberAt = (record: unknown, key: string): number | null =>
  isRecord(record) && typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : null;

/** The uptake a successful moisture_uptake reported in `data`; a malformed result (no finite content or fraction) is a refusal, never a number. */
export function uptakeFromData(data: unknown, summary: string): Uptake | Refused {
  const moisturePercent = numberAt(data, 'moisturePercent');
  const fraction = numberAt(data, 'fraction');
  if (moisturePercent === null || fraction === null) return { code: 'ENV_PROPERTY_MISSING', reason: summary };
  const inputs = isRecord(data) ? data['inputs'] : undefined;
  return {
    moisturePercent,
    fraction,
    saturationPercent: isRecord(inputs) ? numberAt(inputs['saturation'], 'value') : null,
    unverified: !isRecord(data) || data['unverified'] !== false,
  };
}

function uptakeOf(doc: CadDocument, ctx: ExecutionContext | undefined, material: string, thickness: Quantity): Uptake | Refused {
  const result = execute(doc, 'moisture_uptake', { thickness, material, useMissionExposure: true }, ctx);
  return result.error !== undefined ? { code: result.error.code, reason: result.summary } : uptakeFromData(result.data, result.summary);
}

const thicknessOf = (part: Part, given: ReadonlyMap<string, Quantity>): Quantity | undefined =>
  given.get(part.entityId) ?? given.get(part.rootId);

/** Why `thicknesses` cannot be used (no mission humidity exposure, an id given twice, or an id that is no screened part nor its top-level root), or null. */
export function thicknessProblem(
  parts: readonly Part[],
  thicknesses: readonly PartThickness[],
  exposure: HumidityExposure | undefined,
): { readonly message: string; readonly ids: readonly string[] } | null {
  if (thicknesses.length === 0) return null;
  if (exposure === undefined) return { message: 'moistureThickness needs a mission humidityExposure (set_mission_environment)', ids: [] };
  const seen = new Set<string>();
  const repeatedIds = new Set<string>();
  for (const { entityId } of thicknesses) {
    if (seen.has(entityId)) repeatedIds.add(entityId);
    seen.add(entityId);
  }
  const repeated = [...repeatedIds];
  if (repeated.length > 0)
    return { message: `moistureThickness gives ${repeated.slice(0, 10).join(', ')} more than once`, ids: repeated.slice(0, 10) };
  const screened = new Set(parts.flatMap((part) => [part.entityId, part.rootId]));
  const stray = thicknesses.filter((entry) => !screened.has(entry.entityId)).map((entry) => entry.entityId);
  return stray.length === 0
    ? null
    : { message: `moistureThickness names no screened part (with a material): ${stray.slice(0, 10).join(', ')}`, ids: stray.slice(0, 10) };
}

/** Groups the items of one code and material into a finding that carries the part ids. */
function findingsOf(items: readonly MoistureItem[]): EnvItem[] {
  const groups = new Map<string, MoistureItem[]>();
  for (const item of items) {
    if (item.status === 'info' && !item.unverified) continue;
    const code = item.status === 'info' ? 'ENV_VALUE_UNVERIFIED' : item.code;
    const key = `${code}|${item.material}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups].map(([key, group]): EnvItem => {
    const code = key.slice(0, key.indexOf('|'));
    const first = group[0];
    const material = first?.material ?? '';
    const what =
      code === 'ENV_VALUE_UNVERIFIED'
        ? 'moisture state computed from a value without a verified basis'
        : code === 'ENV_MOISTURE_THICKNESS_UNSET'
          ? 'no thickness given (moistureThickness): only the saturation bound is reported'
          : (first?.message ?? code);
    return {
      code,
      severity: code === 'ENV_MOISTURE_THICKNESS_UNSET' ? 'info' : 'warning',
      message: `${material}: ${group.length} part(s): ${what}`,
      entityIds: group.map((item) => item.entityId),
    };
  });
}

/** The moisture state of every part over the mission humidity exposure; status info or unknown, never part of the outgassing status. */
export function moistureSection(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  exposure: HumidityExposure,
  parts: readonly Part[],
  thicknesses: readonly PartThickness[],
  budget: Budget,
): MoistureSection {
  const given = new Map(thicknesses.map((entry) => [entry.entityId, entry.thickness] as const));
  const masses = new Map(budget.perPart.map((entry) => [entry.entityId, entry.massG] as const));
  const uptakes = new Map<string, Uptake | Refused>();
  const saturations = new Map<string, number | null>();
  const at = { T: exposure.temperature };
  const items = parts.map((part): MoistureItem => {
    const thickness = thicknessOf(part, given) ?? null;
    const massG = masses.get(part.entityId) ?? null;
    if (!saturations.has(part.material)) {
      const read = materialProperty(doc, ctx, part.material, 'moistureSaturation', '%', at);
      saturations.set(part.material, isMissing(read) ? null : read.value);
    }
    const saturation = saturations.get(part.material) ?? null;
    const base = { entityId: part.entityId, rootId: part.rootId, material: part.material, thickness, massG };
    const saturationWaterG = saturation === null || massG === null ? null : (saturation / 100) * massG;
    if (thickness === null)
      return {
        ...base,
        status: 'unknown',
        code: 'ENV_MOISTURE_THICKNESS_UNSET',
        moisturePercent: null,
        fraction: null,
        saturationPercent: saturation,
        waterUptakeG: null,
        saturationWaterG,
        unverified: true,
        message: `${part.entityId}: no thickness, so no moisture state; saturation bound ${saturationWaterG === null ? 'unknown' : `${saturationWaterG.toPrecision(6)} g`}`,
      };
    const key = JSON.stringify([part.material, thickness.value, thickness.unit]);
    const uptake = uptakes.get(key) ?? uptakeOf(doc, ctx, part.material, thickness);
    uptakes.set(key, uptake);
    if ('code' in uptake)
      return {
        ...base,
        status: 'unknown',
        code: uptake.code,
        moisturePercent: null,
        fraction: null,
        saturationPercent: saturation,
        waterUptakeG: null,
        saturationWaterG,
        unverified: true,
        message: `${part.entityId}: ${uptake.reason}`,
      };
    return {
      ...base,
      status: 'info',
      code: 'ENV_MOISTURE_STATE',
      moisturePercent: uptake.moisturePercent,
      fraction: uptake.fraction,
      saturationPercent: uptake.saturationPercent ?? saturation,
      waterUptakeG: massG === null ? null : (uptake.moisturePercent / 100) * massG,
      saturationWaterG,
      unverified: uptake.unverified,
      message: `${part.entityId}: ${uptake.moisturePercent.toPrecision(6)} % after ${exposure.duration.value} ${exposure.duration.unit} (G ${uptake.fraction.toPrecision(6)})`,
    };
  });
  return { exposure, items, findings: findingsOf(items) };
}
