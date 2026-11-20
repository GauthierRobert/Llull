/**
 * Vibro-acoustics data (PHY-20, plugin `physics-vibroacoustics`): acoustic spectra (and the exposures that bind them to faces, M2) recorded on
 * `CadDocument.vibroacoustics`. Plain JSON; conversions and reports are queries and store nothing.
 * @invariant a spectrum's `name` is its key; bands sorted by exactMidHz, unique; `unverified` = grade is not 'A'
 */

export interface AcousticBand {
  /** Nominal label, Hz (display and lookup key). */
  readonly nominalHz: number;
  /** Exact mid-band frequency of the base-10 band system, Hz. */
  readonly exactMidHz: number;
  /** Level, dB re 20 uPa (rms, band-limited). */
  readonly splDb: number;
}

interface AcousticSource {
  readonly citation: string;
  readonly grade?: 'A' | 'B' | 'C';
  readonly url?: string;
}

export interface AcousticSpectrum {
  readonly name: string;
  readonly bandwidth: 'octave' | 'third_octave';
  readonly reference: '20uPa';
  readonly bands: readonly AcousticBand[];
  readonly source: AcousticSource;
  readonly unverified: boolean;
}

export interface AcousticExposure {
  readonly name: string;
  readonly spectrum: string;
  readonly target: { readonly entityId: string; readonly facesNear: readonly (readonly [number, number, number])[] };
  readonly field: 'diffuse' | 'progressive';
  readonly incidenceDeg?: number;
  readonly notes?: string;
}

export const REVIEW_DECISIONS = ['accepted', 'rejected'] as const;

/**
 * A qualified reviewer's signed disposition of the acoustic load package of one exposure (`dispose_acoustic_export`).
 * @invariant `exposure` is its key; it covers the package only while `fingerprint` equals the current one (exposure, spectrum, target geometry, units) and in the document `documentUid`
 */
export interface AcousticReview {
  readonly exposure: string;
  readonly decision: (typeof REVIEW_DECISIONS)[number];
  readonly justification: string;
  readonly fingerprint: string;
  readonly signer: string;
  readonly signatureId: string;
  readonly signature: unknown;
  readonly documentUid: string;
  /** Key of the feature step that recorded it (SIG-REPLAY: seeded only while that step is live); absent on older records. */
  readonly stepKey?: string;
}

export interface VibroacousticsModel {
  readonly spectra: Readonly<Record<string, AcousticSpectrum>>;
  readonly spectrumOrder: readonly string[];
  readonly exposures: Readonly<Record<string, AcousticExposure>>;
  readonly exposureOrder: readonly string[];
  /** Signed reviewer dispositions by exposure name (absent until the first one; kept by the replay seed). */
  readonly reviews?: Readonly<Record<string, AcousticReview>>;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first acoustic command (`define_acoustic_spectrum`; plugin `physics-vibroacoustics`, PHY-20). */
    vibroacoustics?: VibroacousticsModel;
  }
}
