/** The gif / mp4 step of render_animation: the PNG frames through the host's `ctx.media` session (MOV-M2, TR-MOV-11). */

import type { MediaEncoder, MediaFailure, MediaPort, MediaSpec } from '../../../model/media';

export type VideoOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly encoder: MediaEncoder }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** NATIVE_TOOL_MISSING stays itself (the binary vanished); every other encoder failure is MOV_ENCODE_FAILED with the host's code quoted. */
const refusal = (failure: MediaFailure, stage: string): VideoOutcome => ({
  ok: false,
  code: failure.code === 'NATIVE_TOOL_MISSING' ? 'NATIVE_TOOL_MISSING' : 'MOV_ENCODE_FAILED',
  message: `${stage}: ${failure.code}: ${failure.message}`,
});

/**
 * @failure open / add / finish failure, or a port that throws -> { ok: false } (the session is aborted, nothing partial is returned)
 */
export function encodeVideo(media: MediaPort, spec: MediaSpec, pngs: readonly Uint8Array[]): VideoOutcome {
  const opened = media.open(spec);
  if ('ok' in opened) return refusal(opened, 'the encoder did not start');
  try {
    for (const [k, png] of pngs.entries()) {
      const failure = opened.add(png);
      if (failure !== null) {
        opened.abort();
        return refusal(failure, `frame ${k + 1} was refused`);
      }
    }
    const done = opened.finish();
    return done.ok ? done : refusal(done, 'the encoder failed');
  } catch (error) {
    opened.abort();
    return {
      ok: false,
      code: 'MOV_ENCODE_FAILED',
      message: `the encoder threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
