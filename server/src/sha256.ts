/** The one SHA-256 helper of the server (node:crypto is allowed here, not in packages/*). */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Lower-case hex SHA-256 of `data` (strings as UTF-8). */
export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Raw 32-byte SHA-256 digest of `value` (fixed-length input for constant-time comparison). */
export const sha256Digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Hex SHA-256 of a file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
