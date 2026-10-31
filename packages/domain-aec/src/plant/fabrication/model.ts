/**
 * Piping fabrication model (plant 05 ISO, TECHNICAL_SPEC §3): the `PipingNetwork` read port every isometric algorithm consumes whatever
 * the source (routed line, legacy pipe, imported PCF), and the stored form of an imported PCF line (`doc.plant.fabrication.pcfLines`).
 * Plugin-side types (plant README D2). Coordinates and bores are world millimetres, whatever units the PCF file used.
 */

import type { Vec3 } from '@core/model/vectors';

export const PCF_COMPONENT_TYPES = [
  'PIPE',
  'ELBOW',
  'BEND',
  'TEE',
  'OLET',
  'REDUCER-CONCENTRIC',
  'REDUCER-ECCENTRIC',
  'FLANGE',
  'FLANGE-BLIND',
  'GASKET',
  'BOLT',
  'VALVE',
  'CAP',
  'WELD',
  'SUPPORT',
  'INSTRUMENT',
] as const;

export type PcfComponentType = (typeof PCF_COMPONENT_TYPES)[number];

export const isPcfComponentType = (word: string): word is PcfComponentType => (PCF_COMPONENT_TYPES as readonly string[]).includes(word);

/** A connection point. `endType` is the PCF end-connection code as written (BW SW FL CP SC PL; other codes are kept verbatim). */
export interface NetworkPoint {
  readonly xyz: Vec3;
  readonly boreMm: number;
  readonly endType?: string;
}

export type ComponentCategory = 'fabrication' | 'erection' | 'offshore';
export type WeldKind = 'shop' | 'site' | 'field_fit';

export interface NetworkComponent {
  /** The llull id (a routed part id, or `pcf:<line>:<n>` for a component read from a PCF without UNIQUE-COMPONENT-IDENTIFIER). */
  readonly id: string;
  readonly type: PcfComponentType;
  /** 0..2 END-POINTs in file order (SUPPORT, OLET, BOLT: none). */
  readonly ends: readonly NetworkPoint[];
  readonly centre?: Vec3;
  /** BRANCH1-POINT. */
  readonly branch?: NetworkPoint;
  /** SUPPORT CO-ORDS. */
  readonly coords?: Vec3;
  /** Isometric symbol key, 4 characters; absent for PIPE and for components whose key is not confirmed (llull never invents one). */
  readonly skey?: string;
  readonly itemCode?: string;
  /** MATERIALS description of `itemCode` (filled by `networkOf`, never stored on the component). */
  readonly description?: string;
  readonly category?: ComponentCategory;
  /** WELD only, from the SKEY WW / WS / WF. */
  readonly weldKind?: WeldKind;
  /** WEIGHT as written, in the file's UNITS-WEIGHT (header `UNITS-WEIGHT`, KGS by default). */
  readonly weight?: number;
  /** Legacy-derived fitting (not placed by a spec). */
  readonly derived?: true;
  /** The catalogue row it came from is not grade A (AF-32). */
  readonly unverified?: true;
  /** Attributes this model does not know, in file order, written back verbatim (a flag has the value ''). */
  readonly extra?: Readonly<Record<string, string>>;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

/** A finding of a read or a derivation (stable `ISO_*` code, ids, paths, one-line fix). */
export interface IsoIssue {
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly remediation: string;
}

/** Pipeline attributes by PCF keyword (PIPING-SPEC, INSULATION-SPEC, PROJECT-IDENTIFIER, REVISION ...), a flag has the value ''. */
export type LineAttributes = Readonly<Record<string, string>>;

/** Read port over one pipe line: components in flow order from the line start. */
export interface PipingNetwork {
  readonly lineId: string;
  readonly attributes: LineAttributes;
  readonly components: readonly NetworkComponent[];
  readonly source: 'route' | 'legacy' | 'pcf';
  readonly warnings: readonly IsoIssue[];
}

/** One MATERIALS entry: `ITEM-CODE <code>` then its indented fields (DESCRIPTION ...). */
export interface PcfMaterial {
  readonly itemCode: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** A record of a type this model does not know, kept verbatim and re-inserted after `after` known components. */
export interface PcfUnknownRecord {
  readonly type: string;
  /** 1-based line of the record keyword in the source file. */
  readonly line: number;
  readonly after: number;
  /** The record came after the MATERIALS block and is written after it. */
  readonly afterMaterials?: true;
  readonly text: readonly string[];
}

export type PcfUnit = 'MM' | 'INCH';

/** The four length units a file declares (bore in INCH is the nominal NPS, see `pcf/pcfUnits.ts`). Bolt units are absent when the file does not declare them. */
export interface PcfUnits {
  readonly bore: PcfUnit;
  readonly coords: PcfUnit;
  readonly boltDia?: PcfUnit;
  readonly boltLength?: PcfUnit;
}

/** A PCF line in storable form (plain JSON): the lossless image of one file on the MVP subset (§6.1). */
export interface PcfLineData {
  readonly lineId: string;
  /** Header values by keyword, without the four length units (they are in `units`). */
  readonly header: Readonly<Record<string, string>>;
  /** Units the file declared; stored coordinates and bores are mm whatever they are. */
  readonly units: PcfUnits;
  readonly attributes: LineAttributes;
  readonly components: readonly NetworkComponent[];
  readonly materials: readonly PcfMaterial[];
  readonly unknownRecords: readonly PcfUnknownRecord[];
}

/** A user-given number with the place it comes from (AF-31: no silent defaults). */
export interface Quantity {
  readonly value: number;
  readonly source: string;
}

/** Shipping limits of a spool; `lengthMm` / `widthMm` / `heightMm` form the envelope compared after sorting both triples. */
export interface SpoolLimits {
  readonly lengthMm?: number;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly weightKg?: number;
  readonly pieces?: number;
  readonly source: string;
}

/** Document-wide fabrication rules (`set_fabrication_rules`). */
export interface FabricationRules {
  readonly weldGapMm?: Quantity;
  readonly fieldFitAllowanceMm?: Quantity;
  readonly minCutPieceMm?: Quantity;
  readonly maxSpool?: SpoolLimits;
  readonly weldPrefix?: { readonly fabrication?: string; readonly erection?: string };
  readonly spoolPrefix?: string;
}

export type FieldWeldType = 'site' | 'field_fit';

/** A weld the user added on a pipe (`add_field_weld`): the network of its line is split there (position in world mm). */
export interface FieldWeldRecord {
  readonly id: string;
  readonly lineId: string;
  readonly xyz: readonly [number, number, number];
  readonly type: FieldWeldType;
}

/** A numbered weld joint. `status: orphaned` = its joint vanished after an edit; the number is kept and never reused. */
export interface WeldRecord {
  readonly id: string;
  readonly lineId: string;
  readonly n: number;
  readonly number: string;
  readonly kind: WeldKind;
  /** The kind was set by `set_weld_type` and wins over the detected one. */
  readonly kindSet: boolean;
  readonly joint: {
    readonly xyz: readonly [number, number, number];
    readonly componentIds: readonly string[];
    readonly boreMm: number;
    readonly endType: string;
  };
  readonly status: 'active' | 'orphaned';
}

export type SpoolBreak = 'field_welds' | 'flanged_joints' | 'line_ends';

/** `doc.plant.fabrication`: absent until the first fabrication command (`import_pcf`). Spools and cut lists are derived, never stored. */
export interface FabricationModel {
  readonly version: 1;
  /** Imported lines kept as read-only data (as: pcf_line), by line id. */
  readonly pcfLines: Readonly<Record<string, PcfLineData>>;
  readonly rules?: FabricationRules;
  /** Field welds by id (ISO-M2). */
  readonly fieldWelds?: Readonly<Record<string, FieldWeldRecord>>;
  /** Numbered welds by id (`<lineId>#<n>`), orphaned ones included. */
  readonly welds?: Readonly<Record<string, WeldRecord>>;
  /** Highest weld number ever given per line (PCF HIGHEST-WELD-NUMBER). */
  readonly highestWeldNumber?: Readonly<Record<string, number>>;
  /** Spool break choice of `split_spools` per line. */
  readonly spoolBreaks?: Readonly<Record<string, readonly SpoolBreak[]>>;
}
