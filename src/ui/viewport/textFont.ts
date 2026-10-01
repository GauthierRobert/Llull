/**
 * @layer ui/viewport
 * Self-hosted font for drei <Text> (troika). Without it troika fetches a default font from a
 * CDN at runtime, which fails offline. troika needs woff/ttf/otf (not woff2).
 */
import geistSansLatin400Url from '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff?url';

export const TEXT_FONT_URL: string = geistSansLatin400Url;
