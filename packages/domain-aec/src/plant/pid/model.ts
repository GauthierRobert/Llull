/**
 * P&ID model (plant 04 PID, TECHNICAL_SPEC §3), stored in `doc.plant.pid` (plant README D2: a plugin-owned slice, typed here, not in core).
 * Sheet coordinates are millimetres on the sheet, rotations degrees CCW, DN an integer. Item ids are step-scoped (`pid-<step>.<k>`). The tag
 * index (normalised tag -> item id) is derived from `items`, never stored.
 */

import type { Vec2 } from '@core/model/vectors';

export const PID_CONVENTIONS = ['ISA-5.1', 'ISO-10628-2'] as const;
export type PidConvention = (typeof PID_CONVENTIONS)[number];

export const PID_ITEM_KINDS = [
  'equipment',
  'nozzle',
  'line',
  'segment',
  'inline',
  'instrument',
  'loop',
  'signal',
  'actuating',
  'opc',
  'annotation',
] as const;
export type PidItemKind = (typeof PID_ITEM_KINDS)[number];

export const PID_PAPERS = ['A0', 'A1', 'A2', 'A3', 'A4'] as const;
export const PID_SHEET_STATUSES = ['draft', 'issued_for_review', 'issued_for_hazop', 'issued_for_construction'] as const;

export interface PidSheet {
  readonly id: string;
  /** Unique, e.g. `PID-001`. */
  readonly number: string;
  readonly title: string;
  readonly paper: (typeof PID_PAPERS)[number];
  readonly revision: string;
  readonly status: (typeof PID_SHEET_STATUSES)[number];
  /** Set only by a human-gated issue (AF-34). */
  readonly issuedBy?: { readonly signer: string; readonly at: string };
}

/** An attribute value; `defaulted` / `unverified` flag a value that was not given by the user or not confirmed (AF-31, AF-32). */
export type PidValue =
  | { readonly kind: 'text'; readonly value: string; readonly defaulted?: true; readonly unverified?: true }
  | { readonly kind: 'quantity'; readonly value: number; readonly unit: string; readonly defaulted?: true; readonly unverified?: true }
  | { readonly kind: 'enum'; readonly value: string; readonly uri?: string };

interface PidItemBase {
  readonly id: string;
  readonly kind: PidItemKind;
  readonly sheetId: string;
  readonly at: Vec2;
  readonly rotationDeg: number;
  /** DEXPI class name (`CentrifugalPump`, `GlobeValve`); `Custom` when unmapped. */
  readonly dexpiClass: string;
  /** RDL URI kept verbatim from an import. */
  readonly classUri?: string;
  /** Full tag (`P-101`, `FIC-101`). */
  readonly tag?: string;
  readonly attributes: Readonly<Record<string, PidValue>>;
  /** Unknown DEXPI or custom attributes, round-tripped verbatim. */
  readonly passthrough?: Readonly<Record<string, string>>;
  /** Id in the imported file (round trip, diagnostics). */
  readonly sourceId?: string;
}

export interface PidEquipment extends PidItemBase {
  readonly kind: 'equipment';
  /** Sub-equipment: the equipment it sits in. */
  readonly parentId?: string;
}

export interface PidNozzle extends PidItemBase {
  readonly kind: 'nozzle';
  readonly equipmentId: string;
  readonly subTag: string;
  readonly dn?: number;
  readonly access?: boolean;
  /** Connection point on the sheet, mm. */
  readonly port: Vec2;
}

export interface PidLine extends PidItemBase {
  /** DEXPI PipingNetworkSystem. */
  readonly kind: 'line';
  readonly lineNumber?: string;
  readonly dn?: number;
  readonly pipingClass?: string;
  readonly fluidCode?: string;
  /** Ordered as authored / imported. */
  readonly segmentIds: readonly string[];
}

export type PidEndpoint =
  | { readonly type: 'nozzle'; readonly itemId: string }
  /** `node` = zero-based port index of the inline item (DEXPI FromNode / ToNode). */
  | { readonly type: 'inline'; readonly itemId: string; readonly node: number }
  | { readonly type: 'branch'; readonly segmentId: string; readonly at: Vec2 }
  | { readonly type: 'opc'; readonly itemId: string }
  | { readonly type: 'free'; readonly at: Vec2 }
  | { readonly type: 'instrument'; readonly itemId: string };

export interface PidSegment extends PidItemBase {
  /** DEXPI PipingNetworkSegment. */
  readonly kind: 'segment';
  readonly lineId: string;
  readonly from: PidEndpoint;
  readonly to: PidEndpoint;
  /** Centre line, mm, both ends included. */
  readonly route: readonly Vec2[];
  readonly flow: 'forward' | 'reverse' | 'none';
  readonly dn?: number;
  readonly pipingClass?: string;
  readonly primary: boolean;
}

export interface PidInline extends PidItemBase {
  readonly kind: 'inline';
  readonly ports: readonly Vec2[];
  readonly dn?: number;
  readonly pipingClass?: string;
  readonly reversed?: boolean;
  readonly operated?: boolean;
}

export const PID_INSTRUMENT_LOCATIONS = ['field', 'central', 'local_panel', 'auxiliary'] as const;
export const PID_INSTRUMENT_DISPLAYS = ['discrete', 'shared', 'plc', 'software'] as const;

export interface PidInstrument extends PidItemBase {
  /** DEXPI ProcessInstrumentationFunction. */
  readonly kind: 'instrument';
  readonly category: string;
  readonly functions: string;
  readonly loopNumber: string;
  readonly location: (typeof PID_INSTRUMENT_LOCATIONS)[number];
  readonly display: (typeof PID_INSTRUMENT_DISPLAYS)[number];
  readonly loopId?: string;
}

export const PID_SIGNAL_KINDS = ['measuring', 'electric', 'pneumatic', 'software', 'capillary'] as const;

export interface PidSignal extends PidItemBase {
  readonly kind: 'signal';
  readonly signalKind: (typeof PID_SIGNAL_KINDS)[number];
  readonly from: PidEndpoint;
  readonly to: PidEndpoint;
  readonly route: readonly Vec2[];
}

export const PID_ACTUATORS = ['diaphragm', 'piston', 'motor', 'solenoid', 'hydraulic', 'general'] as const;
export const PID_FAIL_ACTIONS = ['FC', 'FO', 'FL', 'FAI'] as const;

export interface PidActuating extends PidItemBase {
  readonly kind: 'actuating';
  readonly valveId: string;
  readonly actuator: (typeof PID_ACTUATORS)[number];
  readonly failAction?: (typeof PID_FAIL_ACTIONS)[number];
  readonly controllerId?: string;
}

export interface PidOffPage extends PidItemBase {
  readonly kind: 'opc';
  readonly direction: 'in' | 'out';
  readonly pairKey: string;
  readonly targetSheet?: string;
}

export interface PidPlain extends PidItemBase {
  readonly kind: 'loop' | 'annotation';
}

export type PidItem =
  | PidEquipment
  | PidNozzle
  | PidLine
  | PidSegment
  | PidInline
  | PidInstrument
  | PidSignal
  | PidActuating
  | PidOffPage
  | PidPlain;

export const PID_IMPORT_FORMATS = ['dexpi-proteus', 'dexpi-xml'] as const;

/** Provenance of an import (AF-35): format, version, sha256 of the source text and the warnings it raised. */
export interface PidImportRecord {
  readonly format: (typeof PID_IMPORT_FORMATS)[number];
  readonly version: string;
  readonly sha256: string;
  readonly warnings: readonly string[];
}

/** Accepted finding: who and why (error-severity findings need a human signature, AF-34). */
export interface PidAcceptance {
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export interface PidTagFormat {
  /** Regular expression source a tag of the kind must match. */
  readonly pattern: string;
  readonly separator: string;
}

export const PID_TAG_FORMAT_KINDS = ['equipment', 'instrument', 'valve'] as const;

export interface PidModel {
  readonly version: 1;
  readonly convention: PidConvention;
  /** Tokens: dn, fluid, seq, class, area, unit (e.g. `{dn}-{fluid}-{seq}-{class}`). */
  readonly lineNumberFormat: string;
  readonly tagFormats: Readonly<Partial<Record<(typeof PID_TAG_FORMAT_KINDS)[number], PidTagFormat>>>;
  readonly sheets: Readonly<Record<string, PidSheet>>;
  readonly sheetOrder: readonly string[];
  readonly items: Readonly<Record<string, PidItem>>;
  readonly itemOrder: readonly string[];
  /** findingKey -> acceptance. */
  readonly acceptances?: Readonly<Record<string, PidAcceptance>>;
  readonly imports?: readonly PidImportRecord[];
  /** Per-prefix counters for generated names (sequence numbers). */
  readonly counters: Readonly<Record<string, number>>;
}
