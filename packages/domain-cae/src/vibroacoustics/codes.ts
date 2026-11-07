/** Stable VAC_* codes of the vibro-acoustics commands (TECHNICAL_SPEC §7.1) with their one-line remediation, and the check item shape. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  VAC_BAND_UNKNOWN: 'use the nominal label of the base-10 series (third octave 25 ... 20000 Hz, octave 31.5 ... 16000 Hz), e.g. 1000, 1250',
  VAC_BAND_DUPLICATE: 'remove the duplicate band',
  VAC_REFERENCE_UNSET: "state reference: '20uPa' (dB re 20 micropascal, air); there is no default",
  VAC_NAME_TAKEN: 'choose another name or delete_acoustic_spectrum first',
  VAC_SPECTRUM_UNKNOWN: 'define it with define_acoustic_spectrum (names are listed in the document slice vibroacoustics.spectrumOrder)',
  VAC_SPECTRUM_IN_USE: 'delete the exposure that uses it first',
  VAC_CONVERSION_UNSUPPORTED:
    'supply third-octave data: octave -> third octave cannot be split, and an octave needs all three of its thirds',
  VAC_PARAMS_INVALID: 'follow the command description',
};

export const refuseVac = tableRejection(REMEDIATION);

export interface VacItem {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly remediation: string;
}

/** Warning carried by every report / definition of a spectrum that is not grade A (not suppressible). */
export const unverifiedItem = (name: string): VacItem => ({
  code: 'VAC_SPECTRUM_UNVERIFIED',
  severity: 'warning',
  message: `spectrum '${name}' is not grade A (user data or unconfirmed source)`,
  remediation: 'a qualified reviewer must confirm the source against the programme document',
});
