/** The llull version of this host (the server package version, which the desktop bundle and the CLI share): stamped into crash reports and export provenance (`ctx.hostVersion`). */

import fs from 'fs';
import path from 'path';

let cached: string | undefined;

/** `version` of the server package.json, or 'unknown' when it cannot be read; read once per process. */
export function hostVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
    cached = typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
