/**
 * Electro-optical data (PHY-15, plugin `physics-electro-optical`) recorded on `CadDocument.electroOptical`: coating assignments (a coating is a document
 * material with `record.productForm: 'coating'` and PHY-01 models `emissivityIr` / `absorptivitySolar`; this slice only places it and declares its electrical
 * effect), bond paths and the signed human dispositions of failed paths. Plain JSON; checks are queries and store nothing.
 * @invariant a record's `id` is its key; a disposition is keyed by its path id; quantities carry their unit
 */

interface EopSource {
  readonly citation: string;
  readonly locator?: string | undefined;
}

interface Quantity {
  readonly value: number;
  readonly unit: string;
}

export const COATING_LOCATIONS = ['exposed', 'bonded_interface'] as const;
export const ELECTRICAL_EFFECTS = ['conductive', 'insulating', 'unknown'] as const;

/** A coating placed on a solid: on its outer (radiating / sun-facing) surface, or on a surface it is bonded through. */
export interface CoatingAssignment {
  readonly id: string;
  readonly entityId: string;
  /** Id of the document material (productForm 'coating'). */
  readonly coating: string;
  readonly location: (typeof COATING_LOCATIONS)[number];
  /** Declared by the caller with a source; never inferred. `unknown` never passes a bond check. */
  readonly electrical: (typeof ELECTRICAL_EFFECTS)[number];
  readonly source?: EopSource;
}

export type BondElement =
  | {
      readonly kind: 'joint';
      readonly resistance: Quantity;
      readonly source: EopSource;
      /** The two solids the joint connects (checked against find_contacts and their bonded-interface coatings). */
      readonly interfaces?: readonly [string, string] | undefined;
    }
  | { readonly kind: 'strap'; readonly material: string; readonly length: Quantity; readonly crossSection: Quantity };

export interface BondLimit {
  readonly value: number;
  readonly unit: string;
  readonly ruleId: string;
  readonly source: EopSource;
  /** Always true as authored: no command marks a limit verified. */
  readonly unverified: boolean;
}

export interface BondPath {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly elements: readonly BondElement[];
  readonly limit?: BondLimit;
  readonly temperature?: Quantity;
}

/** SAE ARP5414A lightning zones: 1A / 1B first return stroke (low / high hang-on probability), 1C its transition zone, 2A / 2B swept stroke (low / high hang-on), 3 conducted current only. */
export const LIGHTNING_ZONES = ['1A', '1B', '1C', '2A', '2B', '3'] as const;

/** The lightning zone of a solid as zoned by the applicant (per solid, like coatings; a zoning drawing or report is the source). */
export interface LightningZoneLabel {
  readonly id: string;
  readonly entityId: string;
  readonly zone: (typeof LIGHTNING_ZONES)[number];
  readonly source: EopSource;
}

export const DISPOSITIONS = ['accepted', 'rejected', 'redesign'] as const;

/** A qualified human's decision on a bond path, bound to the path as it was (`inputsHash`) and to the document it was signed for. */
export interface BondDisposition {
  readonly pathId: string;
  readonly decision: (typeof DISPOSITIONS)[number];
  readonly justification: string;
  readonly inputsHash: string;
  readonly signer: string;
  readonly signatureId: string;
  readonly signature: unknown;
  readonly documentUid: string;
  /** Key of the feature step that recorded it (SIG-REPLAY: seeded only while that step is live); absent on older records. */
  readonly stepKey?: string;
}

export interface ElectroOpticalModel {
  readonly coatings: Readonly<Record<string, CoatingAssignment>>;
  readonly bondPaths: Readonly<Record<string, BondPath>>;
  readonly dispositions: Readonly<Record<string, BondDisposition>>;
  /** Absent in files written before set_lightning_zone. */
  readonly zones?: Readonly<Record<string, LightningZoneLabel>>;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first electro-optical command (plugin `physics-electro-optical`, PHY-15). */
    electroOptical?: ElectroOpticalModel;
  }
}
