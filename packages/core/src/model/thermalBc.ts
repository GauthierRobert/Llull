/** PHY-03 §3.1 thermal set-up building blocks: boundary conditions, amplitudes, cavities, contacts, the step and temperature limits. */

import type { FeaTarget } from './feaTarget';
import type { Quantity } from './quantity';

/** Same structural id as `types.ts` `EntityId` (not imported: types.ts imports analysis.ts, which imports this module). */
type EntityId = string;

export interface TableRef {
  readonly csvSha256: string;
  readonly rows: number;
}

/** Film coefficient h(T) of a face: rows [surface temperature on the case scale, h in W/(m^2*K)], strictly increasing temperature, h > 0. */
interface FilmTable {
  readonly points: ReadonlyArray<readonly [temperature: number, filmCoefficient: number]>;
}

export interface Amplitude {
  readonly id: string;
  readonly name: string;
  readonly points: ReadonlyArray<readonly [timeS: number, factor: number]>;
  readonly generatedFrom?: { kind: 'sine' | 'ramp' | 'table'; params: Readonly<Record<string, number>> };
}

export type ThermalBc =
  | { readonly kind: 'temperature'; readonly value: Quantity; readonly target: FeaTarget }
  | { readonly kind: 'surface_flux'; readonly value: Quantity; readonly target: FeaTarget }
  | { readonly kind: 'heat_generation'; readonly value: Quantity; readonly mode: 'density' | 'total'; readonly entityId: EntityId }
  | { readonly kind: 'concentrated_flux'; readonly value: Quantity; readonly target: FeaTarget }
  | {
      readonly kind: 'film';
      readonly filmCoefficient: Quantity | { readonly table: TableRef | FilmTable };
      readonly sinkTemperature: Quantity;
      readonly target: FeaTarget;
    }
  | {
      readonly kind: 'radiation';
      readonly emissivity: number | { readonly fromProperty: 'emissivityIr' };
      readonly sinkTemperature: Quantity;
      readonly target: FeaTarget;
    };

export interface ThermalBcRecord {
  readonly id: string;
  readonly name: string;
  readonly bc: ThermalBc;
  readonly amplitude?: string;
  readonly source?: { readonly citation: string; readonly locator?: string };
}

export interface CavityRadiation {
  readonly id: string;
  readonly name: string;
  readonly environment: { readonly kind: 'open'; readonly temperature: Quantity } | { readonly kind: 'closed' };
  readonly faces: ReadonlyArray<{ readonly target: FeaTarget; readonly emissivity: number | { readonly fromProperty: 'emissivityIr' } }>;
}

export interface ThermalContact {
  readonly id: string;
  readonly name: string;
  readonly master: FeaTarget;
  readonly slave: FeaTarget;
  readonly conductance:
    | Quantity
    | { readonly points: ReadonlyArray<readonly [conductanceW_m2K: number, pressureMPa: number, temperature: number]> };
}

export interface ThermalStep {
  readonly endTimeS?: number;
  readonly initialIncrementS?: number;
  readonly maxIncrementS?: number;
  readonly minIncrementS?: number;
  readonly fixedIncrements?: boolean;
  readonly maxTemperatureChangePerIncrement?: Quantity;
  readonly outputTimesS?: readonly number[];
  readonly outputEveryS?: number;
}

export interface TemperatureLimit {
  readonly id: string;
  readonly name: string;
  readonly scope: { readonly entityId: EntityId } | { readonly target: FeaTarget };
  readonly min?: Quantity;
  readonly max?: Quantity;
  readonly source: { readonly citation: string; readonly locator?: string };
}
