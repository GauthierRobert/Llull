/**
 * Space-environment data (PHY-14, plugin `physics-environment`): the mission environment recorded on `CadDocument.spaceEnvironment`.
 * Calculations (uptake, hygroscopic strain, atomic-oxygen erosion) are queries and store nothing.
 * @invariant a shipped profile is referenced by id; a custom profile always carries its source; every quantity states its unit
 */

export const OUTGASSING_QUANTITIES = ['TML', 'CVCM', 'RML', 'WVR'] as const;
type OutgassingQuantity = (typeof OUTGASSING_QUANTITIES)[number];

export interface OutgassingLimit {
  readonly quantity: OutgassingQuantity;
  readonly op: '<' | '<=';
  /** Percent of the specimen mass. */
  readonly value: number;
  readonly unit: '%';
}

export interface OutgassingProfile {
  readonly id: string;
  readonly label: string;
  readonly limits: readonly OutgassingLimit[];
  readonly testMethod: 'ASTM_E595' | 'ECSS_Q_ST_70_02';
  readonly source: string;
  readonly status: 'verified' | 'secondary' | 'company';
}

export interface Quantity {
  readonly value: number;
  readonly unit: string;
}

export interface HumidityExposure {
  readonly relativeHumidity: number;
  readonly temperature: Quantity;
  readonly duration: Quantity;
  readonly faces: 'both' | 'one';
  readonly source: string;
}

export interface AoFluence {
  readonly value: number;
  readonly unit: 'atoms/cm^2' | 'atoms/m^2';
  readonly source: string;
}

export interface SpaceEnvironment {
  /** Id of a shipped profile, or a custom profile. */
  readonly outgassingProfile?: string | OutgassingProfile;
  readonly humidityExposure?: HumidityExposure;
  readonly aoFluence?: AoFluence;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first `set_mission_environment` (plugin `physics-environment`, PHY-14). */
    spaceEnvironment?: SpaceEnvironment;
  }
}
