/**
 * The image asset store of this machine (RV1 RV-M1): content-addressed texture files, immutable, written atomically.
 *   `<dir>/<sha256>`   the image file as read; key = sha256 of its bytes
 * Environment: LLULL_IMAGE_CACHE (directory, default ~/.llull/cache/image).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ImageAssetPort } from '@core/geometry/imageAssets';

const KEY = /^[0-9a-f]{64}$/;

export const isImageAssetKey = (value: string): boolean => KEY.test(value);

export function imageCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_IMAGE_CACHE'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'cache', 'image');
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface ImageAssetStore extends ImageAssetPort {
  readonly dir: string;
}

/** The store at `dir`. `readImage` checks the content hash: a damaged or replaced file reads as missing. */
export function createImageAssetStore(dir: string = imageCacheDir()): ImageAssetStore {
  return {
    dir,
    readImage(key) {
      if (!isImageAssetKey(key)) return null;
      try {
        const bytes = readFileSync(path.join(dir, key));
        return sha256(bytes) === key ? bytes : null;
      } catch {
        return null;
      }
    },
    writeImage(bytes) {
      const key = sha256(bytes);
      const target = path.join(dir, key);
      if (existsSync(target)) return key;
      mkdirSync(dir, { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, bytes);
      try {
        renameSync(temporary, target);
      } catch (error) {
        rmSync(temporary, { force: true });
        if (!existsSync(target)) throw error;
      }
      return key;
    },
  };
}

let shared: ImageAssetStore | null = null;

/** The process-wide store at the configured directory. */
export function defaultImageAssetStore(): ImageAssetStore {
  shared ??= createImageAssetStore();
  return shared;
}
