// Parsing and formatting of the read-only aerodynamics query results (frontal_area, aero_drag, standard_atmosphere, analyze_airfoil,
// analyze_wing) for the Aerodynamics panel. Pure: unknown command data in, typed views out.

import type { Vec3 } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

export const FLOW_PRESETS = [
  { id: '+x', label: '+X', vector: [1, 0, 0] },
  { id: '-x', label: '-X', vector: [-1, 0, 0] },
  { id: '+y', label: '+Y', vector: [0, 1, 0] },
  { id: '-y', label: '-Y', vector: [0, -1, 0] },
  { id: '+z', label: '+Z', vector: [0, 0, 1] },
  { id: '-z', label: '-Z', vector: [0, 0, -1] },
] as const satisfies ReadonlyArray<{ id: string; label: string; vector: Vec3 }>;

export type FlowPresetId = (typeof FLOW_PRESETS)[number]['id'] | 'custom';

export const SPEED_UNIT_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['m/s', 'm/s'],
  ['km/h', 'km/h'],
  ['kn', 'knots'],
  ['mph', 'mph'],
];

const num = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** Three significant digits, no trailing zeros; very large / small values in exponent form (Reynolds numbers). */
export function formatQuantity(value: number): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(2).replace('e+', 'e');
  return String(Number(value.toPrecision(3)));
}

const PREFIXES: readonly (readonly [number, string])[] = [
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
];

/** `value` in SI `unit` (N, W, Pa) with the engineering prefix that keeps 1-999 in front: 5.67e-4 N → "567 µN". */
export function formatSi(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`;
  const magnitude = Math.abs(value);
  const [factor, prefix] = PREFIXES.find(([scale]) => magnitude >= scale) ?? PREFIXES[PREFIXES.length - 1] ?? [1, ''];
  return `${formatQuantity(value / factor)} ${prefix}${unit}`;
}

/** An area given in m², shown in mm² / cm² / m² so the number stays readable: 4e-6 m² → "4 mm²". */
export function formatArea(areaM2: number): string {
  const magnitude = Math.abs(areaM2);
  if (magnitude > 0 && magnitude < 1e-4) return `${formatQuantity(areaM2 * 1e6)} mm²`;
  if (magnitude > 0 && magnitude < 1e-2) return `${formatQuantity(areaM2 * 1e4)} cm²`;
  return `${formatQuantity(areaM2)} m²`;
}

export interface FrontalView {
  readonly areaM2: number;
  readonly uncertaintyM2: number;
  readonly wettedAreaM2: number;
  readonly lengthM: number;
}

export function parseFrontal(data: unknown): FrontalView | null {
  if (!isRecord(data)) return null;
  const areaM2 = num(data, 'frontalAreaM2');
  const wettedAreaM2 = num(data, 'wettedAreaM2');
  const lengthM = num(data, 'lengthM');
  if (areaM2 === null || wettedAreaM2 === null || lengthM === null) return null;
  return { areaM2, uncertaintyM2: num(data, 'uncertaintyM2') ?? 0, wettedAreaM2, lengthM };
}

export interface DragView {
  readonly cdA: number;
  readonly dragN: number;
  readonly powerW: number;
  readonly dynamicPressurePa: number;
  readonly reynolds: number | null;
  readonly mach: number;
  readonly warnings: readonly string[];
}

export function parseDrag(data: unknown): DragView | null {
  if (!isRecord(data) || !isRecord(data['area'])) return null;
  const cdA = num(data['area'], 'cdA');
  const dragN = num(data, 'dragN');
  const powerW = num(data, 'powerW');
  const dynamicPressurePa = num(data, 'dynamicPressurePa');
  if (cdA === null || dragN === null || powerW === null || dynamicPressurePa === null) return null;
  const warnings = Array.isArray(data['warnings']) ? data['warnings'].filter((item): item is string => typeof item === 'string') : [];
  return { cdA, dragN, powerW, dynamicPressurePa, reynolds: num(data, 'reynolds'), mach: num(data, 'mach') ?? 0, warnings };
}

export interface AtmosphereView {
  readonly temperatureK: number;
  readonly densityKgM3: number;
  readonly viscosityPaS: number;
  readonly speedOfSoundMS: number;
}

export function parseAtmosphere(data: unknown): AtmosphereView | null {
  if (!isRecord(data)) return null;
  const temperatureK = num(data, 'temperatureK');
  const densityKgM3 = num(data, 'densityKgM3');
  const viscosityPaS = num(data, 'dynamicViscosityPaS');
  const speedOfSoundMS = num(data, 'speedOfSoundMS');
  if (temperatureK === null || densityKgM3 === null || viscosityPaS === null || speedOfSoundMS === null) return null;
  return { temperatureK, densityKgM3, viscosityPaS, speedOfSoundMS };
}

interface PolarRow {
  readonly alphaDeg: number;
  readonly cl: number;
  readonly cm: number;
}

export interface AirfoilView {
  readonly label: string;
  readonly chord: number;
  readonly polar: readonly PolarRow[];
  readonly liftSlopePerDeg: number | null;
  readonly zeroLiftAngleDeg: number | null;
  /** Cp per panel control point (chord-normalised x, y) for each angle of attack. */
  readonly surface: ReadonlyArray<{ readonly alphaDeg: number; readonly points: ReadonlyArray<{ x: number; y: number; cp: number }> }>;
}

export function parseAirfoil(data: unknown): AirfoilView | null {
  if (!isRecord(data) || !isRecord(data['airfoil']) || !Array.isArray(data['polar'])) return null;
  const label = data['airfoil']['label'];
  const chord = num(data['airfoil'], 'chord');
  if (typeof label !== 'string' || chord === null) return null;
  const polar = data['polar'].flatMap((row): PolarRow[] => {
    if (!isRecord(row)) return [];
    const [alphaDeg, cl, cm] = [num(row, 'alphaDeg'), num(row, 'cl'), num(row, 'cm')];
    return alphaDeg === null || cl === null || cm === null ? [] : [{ alphaDeg, cl, cm }];
  });
  const surface = (Array.isArray(data['surface']) ? data['surface'] : []).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry['points'])) return [];
    const alphaDeg = num(entry, 'alphaDeg');
    if (alphaDeg === null) return [];
    const points = entry['points'].flatMap((point) => {
      if (!isRecord(point)) return [];
      const [x, y, cp] = [num(point, 'x'), num(point, 'y'), num(point, 'cp')];
      return x === null || y === null || cp === null ? [] : [{ x, y, cp }];
    });
    return [{ alphaDeg, points }];
  });
  return { label, chord, polar, liftSlopePerDeg: num(data, 'liftSlopePerDeg'), zeroLiftAngleDeg: num(data, 'zeroLiftAngleDeg'), surface };
}

interface WingRow {
  readonly alphaDeg: number;
  readonly cl: number;
  readonly cdi: number;
  readonly efficiency: number;
}

export interface WingView {
  readonly areaM2: number;
  readonly aspectRatio: number;
  readonly rows: readonly WingRow[];
}

export function parseWing(data: unknown): WingView | null {
  if (!isRecord(data) || !isRecord(data['geometry']) || !Array.isArray(data['polar'])) return null;
  const areaM2 = num(data['geometry'], 'area');
  const aspectRatio = num(data['geometry'], 'aspectRatio');
  if (areaM2 === null || aspectRatio === null) return null;
  const rows = data['polar'].flatMap((row): WingRow[] => {
    if (!isRecord(row)) return [];
    const [alphaDeg, cl, cdi, efficiency] = [num(row, 'alphaDeg'), num(row, 'cl'), num(row, 'cdi'), num(row, 'spanEfficiency')];
    return alphaDeg === null || cl === null || cdi === null || efficiency === null ? [] : [{ alphaDeg, cl, cdi, efficiency }];
  });
  return { areaM2, aspectRatio, rows };
}

/** Flow direction vector from the panel's preset / custom fields; null while a custom vector is zero or not numeric. */
export function flowVector(preset: FlowPresetId, custom: readonly [string, string, string]): Vec3 | null {
  if (preset !== 'custom') return [...(FLOW_PRESETS.find((item) => item.id === preset)?.vector ?? [1, 0, 0])] as Vec3;
  const parts = custom.map((text) => Number(text));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)) || Math.hypot(...parts) === 0) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
