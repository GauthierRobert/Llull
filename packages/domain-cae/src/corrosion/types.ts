/**
 * Corrosion data (PHY-13, plugin `physics-corrosion`) recorded on `CadDocument.corrosion`: the service environment, the galvanic group of each material,
 * surface systems, declared isolations and the human acceptances of findings. Plain JSON; checks are queries and store nothing.
 * @invariant a record's `id` is its key; an isolation names exactly one of `pair` / `entityId`; acceptances are keyed by item key
 */

export type CorrosionScheme = 'anodic_index' | 'mil_std_889d';
export type CorrosionEnvironment = 'harsh' | 'normal' | 'controlled' | 'artificial_seawater';

export interface CorrosionSource {
  readonly citation: string;
  readonly locator?: string;
}

/** Galvanic data of a material (08 MAT `MaterialRecord` carries only numeric properties, so the group lives here). */
export interface MaterialGalvanic {
  /** Key into the anodic-index table (`ANODIC_GROUPS`). */
  readonly galvanicGroup: string;
  /** Volts; overrides the group's table value, with its own source. */
  readonly anodicIndexV?: number;
  readonly source: CorrosionSource;
}

export const SURFACE_CLASSES = ['none', 'anodize', 'conversion_coating', 'metallic_plating', 'acid_process', 'primer', 'paint'] as const;
export type SurfaceSystemClass = (typeof SURFACE_CLASSES)[number];

export interface SurfaceLayer {
  readonly class: SurfaceSystemClass;
  readonly spec?: string;
  /** Required for `metallic_plating`: the plating's galvanic group (`cadmium_plate`, `zinc`, ...). */
  readonly galvanicGroup?: string;
}

export interface SurfaceSystem {
  readonly id: string;
  readonly entityIds: readonly string[];
  /** Inner to outer. */
  readonly layers: readonly SurfaceLayer[];
}

export const ISOLATION_METHODS = [
  'sealant_faying',
  'sealant_wet_install',
  'primer',
  'conversion_coating',
  'glass_isolation_ply',
  'isolating_washer_or_tape',
] as const;
export type IsolationMethod = (typeof ISOLATION_METHODS)[number];

export interface Isolation {
  readonly id: string;
  readonly pair?: readonly [string, string];
  readonly entityId?: string;
  readonly method: IsolationMethod;
  readonly spec?: string;
  readonly note?: string;
}

/** A qualified human's decision on one finding, bound to the finding as it was (`fingerprint`) and to the document it was signed for. */
export interface Acceptance {
  readonly itemKey: string;
  readonly decision: 'accepted' | 'rejected';
  readonly justification: string;
  readonly fingerprint: string;
  readonly signer: string;
  readonly signatureId: string;
  readonly signature: unknown;
  readonly documentUid: string;
}

export interface CorrosionModel {
  readonly environment?: { readonly scheme: CorrosionScheme; readonly value: CorrosionEnvironment };
  readonly materials: Readonly<Record<string, MaterialGalvanic>>;
  readonly surfaceSystems: Readonly<Record<string, SurfaceSystem>>;
  readonly isolations: Readonly<Record<string, Isolation>>;
  readonly acceptances: Readonly<Record<string, Acceptance>>;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first corrosion command (`set_service_environment`; plugin `physics-corrosion`, PHY-13). */
    corrosion?: CorrosionModel;
  }
}
