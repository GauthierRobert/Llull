/**
 * Content-addressed binary files of the flow results (12 CFD M3a): `field.bin` of each solve (bound by hash in its `cfd_result` bundle) and
 * the `slice.bin` / `streamlines.bin` a query produces, as `<dir>/<sha256>.bin` (`<FE store>/cfd-files`). A field file can exceed what one
 * JavaScript Buffer holds (2 GiB), so files are hashed by stream and copied by path, never read whole; the reader of a field (`llull-compute
 * flow-query`) re-hashes it against the hash the bundle names.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { copyFile, link, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../sha256';

const HASH = /^[0-9a-f]{64}$/;

export interface StoredFile {
  readonly sha256: string;
  readonly bytes: number;
}

export interface CfdFileStore {
  /** Stores small `bytes` (slices, streamlines) and returns their sha256 (idempotent). */
  put(bytes: Buffer): string;
  /**
   * Stores the file at `source` whose streamed hash and size the caller already has (`hashFile`, compared with what it expected
   * first: nothing is copied for a file the caller rejects). Idempotent; concurrent stores of the same content both succeed.
   */
  putFile(source: string, known: StoredFile): Promise<StoredFile>;
  /** The verified bytes of a small stored file, or null when absent or damaged. */
  get(hash: string): Buffer | null;
  /** Path of a stored file, or null when absent (its content is checked by whoever reads it). */
  pathOf(hash: string): string | null;
  readonly directory: string;
}

/** sha256 and byte count of a file, read by stream. */
export function hashFile(file: string): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(file)
      .on('data', (chunk: Buffer | string) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += data.length;
        hash.update(data);
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

/** The first `count` bytes of a file (fewer when it is shorter). */
export async function readHead(file: string, count: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Places `source` at `target` as a hard link when the volume allows it, else as a copy. */
export async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

/** The store under `<artifactDirectory>/cfd-files`. */
export function cfdFileStore(artifactDirectory: string): CfdFileStore {
  const directory = path.join(artifactDirectory, 'cfd-files');
  const fileOf = (hash: string): string => path.join(directory, `${hash}.bin`);
  return {
    directory,
    put(bytes) {
      const hash = sha256Hex(bytes);
      const target = fileOf(hash);
      if (existsSync(target) && this.get(hash) !== null) return hash;
      mkdirSync(directory, { recursive: true });
      const partial = `${target}.${process.pid}.tmp`;
      writeFileSync(partial, bytes);
      renameSync(partial, target);
      return hash;
    },
    async putFile(source, known) {
      if (!HASH.test(known.sha256)) throw new Error(`not a sha256: '${known.sha256}'`);
      const target = fileOf(known.sha256);
      const sizeOf = async (file: string): Promise<number | null> => (await stat(file).catch(() => null))?.size ?? null;
      // A stored file of the right size is this content (its reader re-hashes it); a damaged one of another size is replaced.
      if ((await sizeOf(target)) === known.bytes) return known;
      mkdirSync(directory, { recursive: true });
      // One temp name per call: two solves storing the same field at once must not share (and rename away) one partial file.
      const partial = `${target}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, partial);
        await rename(partial, target);
      } catch (error) {
        // A concurrent store won the rename (Windows refuses to replace a file another handle holds): its file is the success.
        const winner = (await sizeOf(target)) === known.bytes ? await hashFile(target) : null;
        if (winner?.sha256 !== known.sha256) throw error;
      } finally {
        await rm(partial, { force: true });
      }
      return known;
    },
    get(hash) {
      if (!HASH.test(hash)) return null;
      try {
        const bytes = readFileSync(fileOf(hash));
        return sha256Hex(bytes) === hash ? bytes : null;
      } catch {
        return null;
      }
    },
    pathOf(hash) {
      return HASH.test(hash) && existsSync(fileOf(hash)) ? fileOf(hash) : null;
    },
  };
}
