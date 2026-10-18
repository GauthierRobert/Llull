/** Durability slice (PHY-07 fatigue, PHY-08 fracture): load histories, fatigue cases, cracks and crack-growth cases. Pure definition data. */

import type { Quantity } from './quantity';

export interface LoadHistory {
  readonly id: string;
  readonly name: string;
  /** `stress` and `strain` histories carry physical values; `load_factor` scales a load case (unit "-"). */
  readonly kind: 'stress' | 'load_factor' | 'strain';
  readonly unit: string;
  readonly data:
    | { readonly form: 'series'; readonly values: readonly number[] }
    | { readonly form: 'blocks'; readonly rows: ReadonlyArray<{ readonly max: number; readonly min: number; readonly cycles: number }> };
  readonly repeats: 'once' | 'repeating';
  readonly source: { readonly citation: string };
}

export interface FatigueFactors {
  readonly scatter?: { readonly value: number; readonly source: string };
  readonly damageLimit: number;
  readonly marginalBand?: number;
  /** Marin-type modifiers: each multiplies the curve strength; justification is mandatory. */
  readonly modifiers: ReadonlyArray<{
    readonly name: 'surface' | 'size' | 'reliability' | 'environment' | 'other';
    readonly value: number;
    readonly justification: string;
  }>;
  readonly compressiveMean: 'no_benefit' | 'formula';
}

export type MeanStressModel = 'none' | 'goodman' | 'gerber' | 'soderberg' | 'morrow' | 'swt' | { readonly walker: number };

interface FatigueNotch {
  readonly kt: number;
  readonly q: number;
  readonly feIncludesKt: boolean;
}

export interface FatigueCase {
  readonly id: string;
  readonly name: string;
  readonly method: 'stress_life' | 'strain_life';
  readonly analysisId?: string;
  readonly mapping: ReadonlyArray<{ readonly loadCase?: string | undefined; readonly historyId: string; readonly scale: number }>;
  readonly measure: 'signed_von_mises' | 'max_principal' | { readonly component: 'sxx' | 'syy' | 'szz' | 'sxy' | 'syz' | 'szx' };
  readonly locations: { readonly mode: 'hotspots'; readonly count: number };
  readonly material: { readonly recordId: string; readonly modelId: string; readonly cyclicModelId?: string | undefined };
  readonly meanStress: MeanStressModel;
  readonly notch?: FatigueNotch;
  readonly counting: {
    readonly method: 'rainflow_3pt' | 'rainflow_4pt' | 'rainflow_repeating';
    readonly residue: 'half_cycles' | 'repeat';
    readonly gate?: number | undefined;
  };
  readonly requiredLife: {
    readonly value: number;
    readonly unit: 'cycles' | 'blocks' | 'flights' | 'hours';
    /** Blocks per flight / hour (needed for those units). */
    readonly blocksPerUnit?: number | undefined;
  };
  readonly factors: FatigueFactors;
}

export type CrackGeometry =
  | { readonly kind: 'center_through'; readonly a: Quantity; readonly W: Quantity; readonly t: Quantity }
  | {
      readonly kind: 'edge_through';
      readonly a: Quantity;
      readonly b: Quantity;
      readonly t: Quantity;
      readonly form: 'tada' | 'polynomial';
    }
  | { readonly kind: 'surface_semi_elliptical'; readonly a: Quantity; readonly c: Quantity; readonly t: Quantity; readonly b: Quantity };

export interface Crack {
  readonly id: string;
  readonly name: string;
  readonly geometry: CrackGeometry;
  readonly referenceStress: { readonly source: 'history' };
}

export interface DamageToleranceFactors {
  readonly scatterThreshold?: { readonly value: number; readonly source: string };
  readonly scatterInterval?: { readonly value: number; readonly source: string };
  readonly marginalBand?: number;
}

export interface CrackGrowthCase {
  readonly id: string;
  readonly name: string;
  readonly crackId: string;
  readonly material: { readonly recordId: string; readonly growthModelId: string; readonly toughnessModelId: string };
  readonly histories: ReadonlyArray<{ readonly historyId: string; readonly scale: number }>;
  readonly sequence: 'cycle_by_cycle' | 'rainflow_blocks';
  readonly integration: { readonly maxDaOverA: number };
  readonly growth: { readonly aInitial: Quantity; readonly aDetectable?: Quantity | undefined; readonly aTarget?: Quantity | undefined };
  readonly residualStrengthStress?: Quantity;
  readonly factors: DamageToleranceFactors;
}

export interface DurabilityModel {
  readonly histories: Readonly<Record<string, LoadHistory>>;
  readonly historyOrder: readonly string[];
  readonly fatigueCases: Readonly<Record<string, FatigueCase>>;
  readonly fatigueCaseOrder: readonly string[];
  readonly cracks: Readonly<Record<string, Crack>>;
  readonly crackOrder: readonly string[];
  readonly crackGrowthCases: Readonly<Record<string, CrackGrowthCase>>;
  readonly crackGrowthCaseOrder: readonly string[];
}
