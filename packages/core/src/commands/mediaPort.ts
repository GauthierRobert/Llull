import type { MediaPort } from '../model/media';

let installed: MediaPort | null = null;

/** Install (or with null, remove) the process video encoder (`ctx.media` of the default context). Composition roots / hosts only. */
export function setMediaPort(port: MediaPort | null): void {
  installed = port;
}

/** The installed video encoder, or null (llull is fully usable without it: APNG and PNG frames need none). */
export function getMediaPort(): MediaPort | null {
  return installed;
}
