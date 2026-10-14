// Self-hosted troika font (woff/ttf/otf, not woff2): troika's default is fetched from a CDN and fails offline.
import hankenGroteskLatin400Url from '@fontsource/hanken-grotesk/files/hanken-grotesk-latin-400-normal.woff?url';
import type { TextEntity } from '@core/model/types';

export const TEXT_FONT_URL: string = hankenGroteskLatin400Url;

/** anchorX expected by drei <Text> from a text entity's anchor; anything but center / right is left. */
export function toAnchorX(anchor: TextEntity['anchor']): 'left' | 'center' | 'right' {
  if (anchor === 'center') return 'center';
  if (anchor === 'right') return 'right';
  return 'left';
}
