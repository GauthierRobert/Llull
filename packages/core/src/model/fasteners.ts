/**
 * Fastener catalogue and stack data (aerospace 08 MAT §3.3–3.4, step AERO-3), owned by the `fasteners` plugin
 * (`CadDocument.fasteners`, validated by its `DocumentExtension`).
 */

import type { Quantity } from './quantity';
import type { Provenance } from './propertyModel';
import type { LicenceFlag } from './materialLibrary';
import type { Vec3 } from './vectors';

export type FastenerKind = 'bolt' | 'hi_lok_pin' | 'solid_rivet' | 'blind_rivet' | 'lockbolt' | 'nut' | 'washer' | 'collar' | 'insert';

/** One ordered field of a part-number grammar. */
export type PartNumberField =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'code'; readonly name: string; readonly table: Readonly<Record<string, string>> }
  | { readonly kind: 'int'; readonly name: string; readonly scale?: number; readonly unit?: string; readonly optional?: boolean };

export interface FastenerDimension {
  readonly min?: number;
  readonly max?: number;
  readonly nominal?: number;
  readonly unit: string;
  readonly provenance: Provenance;
}

export interface FastenerSize {
  readonly dash: string;
  readonly nominalDiameter: Quantity;
  readonly thread?: string;
  readonly threadsPerInch?: number;
  readonly threadLength?: Quantity;
  readonly dims: Readonly<Record<string, FastenerDimension>>;
  readonly holeDiameter?: { readonly min: number; readonly max: number; readonly unit: string; readonly provenance: Provenance };
}

export interface FastenerFamily {
  readonly id: string;
  readonly kind: FastenerKind;
  readonly standard: { readonly body: string; readonly id: string; readonly revision?: string };
  readonly partNumber: readonly PartNumberField[];
  readonly gripIncrement?: Quantity;
  readonly gripMode?: 'min_grip_ge_stack' | 'max_grip_range';
  readonly lengthRule?:
    | { readonly kind: 'grip_plus_thread' }
    | { readonly kind: 'stack_plus_k_d'; readonly k: number; readonly round: 'up' | 'nearest'; readonly step: Quantity };
  readonly sizes: readonly FastenerSize[];
  readonly availableGripDash?: { readonly min: number; readonly max: number };
  readonly licence: LicenceFlag;
  readonly provenance: Provenance;
}

/** A placed fastener stack (§3.4); id step-scoped `fst-<step>.<k>`. */
export interface FastenerStack {
  readonly id: string;
  readonly axis: { readonly origin: Vec3; readonly direction: Vec3 };
  readonly layers: ReadonlyArray<{ readonly entityId: string; readonly thickness: number }>;
  readonly fastener: { readonly family: string; readonly partNumber: string; readonly instanceId: string };
  readonly washers: ReadonlyArray<{ readonly partNumber: string; readonly instanceId: string; readonly side: 'head' | 'nut' }>;
  readonly nut?: { readonly partNumber: string; readonly instanceId: string };
  /** Stack thickness in document units when inserted (regrip check). */
  readonly stackThickness: number;
}

/** `CadDocument.fasteners`: catalogues by family id and placed stacks by id. */
export interface FastenerModel {
  readonly catalogs: Readonly<Record<string, FastenerFamily>>;
  readonly stacks: Readonly<Record<string, FastenerStack>>;
}

/** Standard-part reference on a `Component` (generic: the BOM groups by part number without importing the plugin). */
export interface PartRef {
  readonly family: string;
  readonly partNumber: string;
  readonly description?: string;
  readonly unitMass?: Quantity;
  /** Built from placeholder proportions: excluded from mass (TR-MAT-24). */
  readonly representative?: boolean;
}
