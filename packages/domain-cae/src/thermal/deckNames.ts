/** Names the thermal deck gives to amplitudes and output sets. */

import { safeName } from '../decks/context';

export const amplitudeName = (amplitudeId: string): string => `AM_${safeName(amplitudeId)}`;

/** `*TIME POINTS` set holding the requested result times. */
export const OUTPUT_TIME_POINTS = 'TP_OUT';
