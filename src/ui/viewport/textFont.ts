// Self-hosted troika font (woff/ttf/otf, not woff2): troika's default is fetched from a CDN and fails offline.
import hankenGroteskLatin400Url from '@fontsource/hanken-grotesk/files/hanken-grotesk-latin-400-normal.woff?url';
import { configureTextBuilder } from 'troika-three-text';
import type { TextEntity } from '@core/model/types';

export const TEXT_FONT_URL: string = hankenGroteskLatin400Url;

/** anchorX expected by drei <Text> from a text entity's anchor; anything but center / right is left. */
export function toAnchorX(anchor: TextEntity['anchor']): 'left' | 'center' | 'right' {
  if (anchor === 'center') return 'center';
  if (anchor === 'right') return 'right';
  return 'left';
}

/**
 * troika typesets in a blob worker that loads its modules with importScripts(blob:), which the served page policy (script-src 'self',
 * server/src/security.ts) refuses: every label then throws and takes the canvas down. Typeset on the main thread instead; call once
 * before the first <Text> mounts.
 */
export function configureTextLayout(): void {
  configureTextBuilder({ useWorker: false });
}
