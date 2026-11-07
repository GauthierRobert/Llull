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

export interface VibroacousticsModel {
  readonly spectra: Readonly<Record<string, AcousticSpectrum>>;
  readonly spectrumOrder: readonly string[];
  readonly exposures: Readonly<Record<string, AcousticExposure>>;
  readonly exposureOrder: readonly string[];
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first acoustic command (`define_acoustic_spectrum`; plugin `physics-vibroacoustics`, PHY-20). */
    vibroacoustics?: VibroacousticsModel;
  }
}
