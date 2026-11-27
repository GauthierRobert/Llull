// One THREE.Texture per (image asset key, colour space / kind), shared by every material that uses it and disposed when the last user
// releases it (R9). Bytes come from the local backend's `GET /assets/image/<key>` (same base URL and bearer token as every other
// renderer request). No backend, a refused or malformed fetch: the entry fails ONCE (one console.warn) and readers see `null`, so the
// callers fall back to the channel value / material colour.

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { TextureColorSpace } from '@core/model/appearance';
import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';

export type ImageTextureKind = TextureColorSpace | 'hdr';

/** Loads the texture of `key`; rejects on any failure. Replaceable for tests. */
export type ImageTextureLoader = (key: string, kind: ImageTextureKind) => Promise<THREE.Texture>;

async function fetchBlob(key: string): Promise<Blob> {
  const response = await fetch(`${SERVER_BASE}/assets/image/${encodeURIComponent(key)}`, { headers: serverAuthHeaders() });
  if (!response.ok) throw new Error(`image ${key.slice(0, 12)} unavailable (${response.status})`);
  return response.blob();
}

function loadWithObjectUrl(
  blob: Blob,
  load: (url: string, done: (texture: THREE.Texture) => void, fail: (error: unknown) => void) => void,
): Promise<THREE.Texture> {
  const url = URL.createObjectURL(blob);
  return new Promise<THREE.Texture>((resolve, reject) => {
    load(url, resolve, reject);
  }).finally(() => URL.revokeObjectURL(url));
}

const fetchingLoader: ImageTextureLoader = async (key, kind) => {
  const blob = await fetchBlob(key);
  if (kind === 'hdr') {
    const texture = await loadWithObjectUrl(blob, (url, done, fail) => {
      new HDRLoader().load(url, (loaded) => done(loaded), undefined, fail);
    });
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }
  const texture = await loadWithObjectUrl(blob, (url, done, fail) => {
    new THREE.TextureLoader().load(url, done, undefined, fail);
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.colorSpace = kind === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return texture;
};

let loader: ImageTextureLoader = fetchingLoader;

/** Tests: swap the loader (no argument restores the backend one) and drop every entry. */
export function resetImageTextureCache(replacement?: ImageTextureLoader): void {
  for (const entry of entries.values()) entry.texture?.dispose();
  entries.clear();
  loader = replacement ?? fetchingLoader;
  warned = false;
}

interface Entry {
  refs: number;
  texture: THREE.Texture | null;
  failed: boolean;
  readonly listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();
let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`llull: texture unavailable, using the material colour (${error instanceof Error ? error.message : String(error)})`);
}

function start(id: string, key: string, kind: ImageTextureKind, entry: Entry): void {
  const notify = (): void => entry.listeners.forEach((listener) => listener());
  loader(key, kind).then(
    (texture) => {
      // Released while loading: nobody wants it any more.
      if (entries.get(id) !== entry) texture.dispose();
      else entry.texture = texture;
      notify();
    },
    (error: unknown) => {
      entry.failed = true;
      warnOnce(error);
      notify();
    },
  );
}

export interface ImageTextureHandle {
  /** The texture once loaded; null while loading or after a failure. */
  read(): THREE.Texture | null;
  release(): void;
}

/** `onChange` fires when the texture becomes ready (or the load fails). Call `release` exactly once. */
export function acquireImageTexture(key: string, kind: ImageTextureKind, onChange: () => void): ImageTextureHandle {
  const id = `${kind}:${key}`;
  let entry = entries.get(id);
  if (entry === undefined) {
    entry = { refs: 0, texture: null, failed: false, listeners: new Set() };
    entries.set(id, entry);
    start(id, key, kind, entry);
  }
  const held = entry;
  held.refs += 1;
  held.listeners.add(onChange);
  // Already loaded (or failed) by an earlier user: nothing will notify, so say so once, asynchronously.
  if (held.texture !== null || held.failed) queueMicrotask(onChange);
  let released = false;
  return {
    read: () => held.texture,
    release: () => {
      if (released) return;
      released = true;
      held.listeners.delete(onChange);
      held.refs -= 1;
      if (held.refs > 0) return;
      held.texture?.dispose();
      if (entries.get(id) === held) entries.delete(id);
    },
  };
}
