/**
 * Fastener catalogue and stack data (aerospace 08 MAT §3.3–3.4, step AERO-3), owned by the `fasteners` plugin
 * (`CadDocument.fasteners`, validated by its `DocumentExtension`).
 */

import type { Quantity } from '@core/model/quantity';
import type { Provenance } from '@core/model/propertyModel';
import type { LicenceFlag } from '@core/model/materialLibrary';
import type { Vec3 } from '@core/model/vectors';

type FastenerKind = 'bolt' | 'hi_lok_pin' | 'solid_rivet' | 'blind_rivet' | 'lockbolt' | 'nut' | 'washer' | 'collar' | 'insert';

/** One ordered field of a part-number grammar. */
export type PartNumberField =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'code'; readonly name: string; readonly table: Readonly<Record<string, string>> }
  | {
      readonly kind: 'int';
      readonly name: string;
      /** Value of one unit of the integer (the grip dash `10` with scale 0.0625 `in` is 0.625 in). */
      readonly scale?: number;
      readonly unit?: string;
      readonly optional?: boolean;
      /** Zero-padded digit count when printed and exact digit count when decoded (`NAS62` + `04`); absent: any number of digits. */
      readonly width?: number;
    };

interface FastenerDimension {
  readonly min?: number;
  readonly max?: number;
  readonly nominal?: number;
  /** Discrete catalogue values (a washer's available thicknesses), in `unit`. */
  readonly options?: readonly number[];
  readonly unit: string;
  readonly provenance: Provenance;
}

export interface FastenerSize {
  readonly dash: string;
  /** Full part number of a nut/washer size whose grammar has choices (`MS21042L3`); absent: formatted from the grammar. */
  readonly partNumber?: string;
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
  readonly fastener: { readonly family: string; readonly partNumber: string; readonly instanceId: string; readonly diameterDash: string };
  readonly washers: ReadonlyArray<{ readonly partNumber: string; readonly instanceId: string; readonly side: 'head' | 'nut' }>;
  readonly nut?: { readonly partNumber: string; readonly instanceId: string };
  /** Stack thickness in document units when inserted (regrip check). */
  readonly stackThickness: number;
  readonly holeMode: 'cut_close_tolerance' | 'cut_clearance' | 'none';
  /** Hole diameter in document units (0 when `holeMode` is `none`). */
  readonly holeDiameter: number;
  /** Id of the first stack of the row this stack was placed with (`insert_fastener_row`). */
  readonly rowId?: string;
}

/** `CadDocument.fasteners`: catalogues by family id and placed stacks by id. */
export interface FastenerModel {
  readonly catalogs: Readonly<Record<string, FastenerFamily>>;
  readonly stacks: Readonly<Record<string, FastenerStack>>;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first fastener command (plugin `fasteners`, 08 MAT M5). */
    fasteners?: FastenerModel;
  }
}
