/**
 * Durability variants of the material-model union, included verbatim from PHY-07 TECHNICAL_SPEC §3.1 (fatigue) and PHY-08 TECHNICAL_SPEC §3.1
 * (crack growth, toughness). Their physics rules live in those packs; PHY-02 stores and validates their structure only.
 */

import type { Quantity } from './quantity';

interface FatigueTestConditions {
  readonly stressRatio?: number;
  readonly specimenKt?: number;
  readonly surface?: string;
  readonly environment?: string;
  readonly temperature?: Quantity;
  readonly testedLifeRange?: { readonly minCycles: number; readonly maxCycles: number };
  readonly probability: 'mean' | 'P90' | 'P95' | 'P99' | 'design' | 'unspecified';
  readonly control: 'load' | 'strain';
}

export type FatigueMaterialModel =
  | {
      readonly kind: 'sn_basquin';
      readonly sigmaF: Quantity;
      readonly b: number;
      readonly enduranceAmplitude?: Quantity;
      readonly conditions: FatigueTestConditions;
    }
  | {
      readonly kind: 'sn_power_law';
      readonly k: number;
      readonly nD: number;
      readonly sD: Quantity;
      readonly k2?: number | 'cutoff';
      readonly conditions: FatigueTestConditions;
    }
  | {
      readonly kind: 'sn_table';
      readonly families: ReadonlyArray<{
        readonly stressRatio?: number;
        readonly meanStress?: Quantity;
        readonly points: ReadonlyArray<readonly [cycles: number, amplitude: number]>;
        readonly amplitudeUnit: string;
        readonly runoutCycles?: number;
      }>;
      readonly measure: 'amplitude' | 'max';
      readonly conditions: FatigueTestConditions;
    }
  | {
      readonly kind: 'sn_equivalent_stress';
      readonly a1: number;
      readonly a2: number;
      readonly a3: number;
      readonly a4: number;
      readonly unit: string;
      readonly conditions: FatigueTestConditions;
    }
  | {
      readonly kind: 'en_coffin_manson';
      readonly sigmaF: Quantity;
      readonly b: number;
      readonly epsF: number;
      readonly c: number;
      readonly E: Quantity;
      readonly conditions: FatigueTestConditions;
    }
  | { readonly kind: 'cyclic_ramberg_osgood'; readonly Kprime: Quantity; readonly nPrime: number; readonly E: Quantity }
  | {
      readonly kind: 'haigh_table';
      readonly lifeCycles: number;
      readonly points: ReadonlyArray<readonly [mean: number, amplitude: number]>;
      readonly unit: string;
    };

interface CrackGrowthConditions {
  readonly stressRatio?: number | 'per_curve';
  readonly environment?: string;
  readonly temperature?: Quantity;
  readonly orientation?: 'L-T' | 'T-L' | 'L-S' | 'T-S' | 'S-L' | 'S-T' | 'isotropic';
  readonly thickness?: Quantity;
  readonly testStandard?: string;
  readonly dKRange?: { readonly min: number; readonly max: number; readonly unit: string };
}

export type CrackGrowthMaterialModel =
  | {
      readonly kind: 'da_dn_paris';
      readonly C: number;
      readonly m: number;
      readonly units: 'm/cycle|MPa*m^0.5' | 'in/cycle|ksi*in^0.5';
      readonly dKth?: number;
      readonly conditions: CrackGrowthConditions;
    }
  | {
      readonly kind: 'da_dn_walker';
      readonly C: number;
      readonly m: number;
      readonly gamma: number;
      readonly gammaNegativeR?: number;
      readonly convention: 'dK_over_(1-R)^(1-gamma)';
      readonly units: string;
      readonly conditions: CrackGrowthConditions;
    }
  | {
      readonly kind: 'da_dn_forman';
      readonly C: number;
      readonly n: number;
      readonly Kc: number;
      readonly units: string;
      readonly conditions: CrackGrowthConditions;
    }
  | {
      readonly kind: 'da_dn_nasgro';
      readonly C: number;
      readonly n: number;
      readonly p: number;
      readonly q: number;
      readonly threshold:
        | { readonly dK0: number; readonly Cth_pos?: number; readonly Cth_neg?: number; readonly a0?: number }
        | { readonly dKth: number };
      readonly toughness:
        | { readonly Kc: number }
        | { readonly KIc: number; readonly Ak: number; readonly Bk: number; readonly t0?: number };
      readonly closure:
        | { readonly kind: 'newman'; readonly alpha: number; readonly smaxOverSigma0: number }
        | { readonly kind: 'table'; readonly points: ReadonlyArray<readonly [R: number, f: number]> }
        | { readonly kind: 'none' };
      readonly units: string;
      readonly conditions: CrackGrowthConditions;
    }
  | {
      readonly kind: 'da_dn_table';
      readonly families: ReadonlyArray<{
        readonly stressRatio: number;
        readonly points: ReadonlyArray<readonly [dK: number, dadN: number]>;
      }>;
      readonly interpolation: 'log_log';
      readonly units: string;
      readonly conditions: CrackGrowthConditions;
    }
  | {
      readonly kind: 'fracture_toughness';
      readonly KIc?: Quantity;
      readonly Kc?: ReadonlyArray<{ readonly thickness: Quantity; readonly value: Quantity }>;
      readonly state: 'plane_strain' | 'plane_stress' | 'thickness_table';
      readonly orientation?: CrackGrowthConditions['orientation'];
      readonly testStandard?: string;
    };
