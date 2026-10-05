/**
 * @layer ui/viewport
 * Self-hosted font for drei <Text> (troika). Without it troika fetches a default font from a
 * CDN at runtime, which fails offline. troika needs woff/ttf/otf (not woff2).
 */
import geistSansLatin400Url from '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff?url';
import type { TextEntity } from '@core/model/types';

export const TEXT_FONT_URL: string = geistSansLatin400Url;

/** anchorX expected by drei <Text> from a text entity's anchor; anything but center / right is left. */
export function toAnchorX(anchor: TextEntity['anchor']): 'left' | 'center' | 'right' {
  if (anchor === 'center') return 'center';
  if (anchor === 'right') return 'right';
  return 'left';
}
