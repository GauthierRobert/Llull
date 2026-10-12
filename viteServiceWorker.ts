/**
 * Build-time service worker: emits `sw.js` = the build manifest (version + precache list + the
 * policy of serviceWorker/config.json) prepended to serviceWorker/sw.js. The version is a hash of
 * the precached files, so every deploy that changes the shell changes `sw.js` bytes — which is
 * what makes the browser detect an update (src/ui/services/appUpdates.ts handles it).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { z } from 'zod';

const regexSource = z.string().refine((source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

const policySchema = z.object({
  precache: z.object({
    /** Files written outside the bundle (index.html, public/) that are always precached. */
    shell: z.array(z.string().min(1)),
    include: regexSource,
    exclude: regexSource,
    maxEntryBytes: z.number().int().positive(),
  }),
  runtime: z.object({ cacheFirst: regexSource, exclude: regexSource }),
  navigation: z.object({ fallback: z.string().startsWith('/'), bypass: regexSource }),
});

type ServiceWorkerPolicy = z.infer<typeof policySchema>;

interface BuiltFile {
  readonly fileName: string;
  readonly bytes: number;
}

interface ServiceWorkerManifest {
  readonly version: string;
  readonly precache: readonly string[];
  readonly runtime: ServiceWorkerPolicy['runtime'];
  readonly navigation: ServiceWorkerPolicy['navigation'];
}

export function parseServiceWorkerPolicy(json: unknown): ServiceWorkerPolicy {
  return policySchema.parse(json);
}

/**
 * The files to precache (policy-filtered bundle files + the shell list, sorted) and a version
 * hashed from the worker source and the bundle files' contents (index.html only changes when
 * they do) — so any change to either gets a fresh cache.
 */
export function buildServiceWorkerManifest(
  files: readonly BuiltFile[],
  policy: ServiceWorkerPolicy,
  contentHashOf: (fileName: string) => string,
  workerSource: string,
): ServiceWorkerManifest {
  const include = new RegExp(policy.precache.include);
  const exclude = new RegExp(policy.precache.exclude);
  const precache = files
    .filter(
      (file) =>
        include.test(file.fileName) &&
        !exclude.test(file.fileName) &&
        file.bytes <= policy.precache.maxEntryBytes,
    )
    .map((file) => file.fileName)
    .concat(policy.precache.shell)
    .sort();
  const version = createHash('sha256')
    .update(workerSource)
    .update(precache.map((fileName) => `${fileName}:${contentHashOf(fileName)}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { version, precache, runtime: policy.runtime, navigation: policy.navigation };
}

export function serviceWorkerScript(manifest: ServiceWorkerManifest, workerSource: string): string {
  return `self.LLULL_SW = ${JSON.stringify(manifest)};\n${workerSource}`;
}

export function serviceWorkerPlugin(root: string): Plugin {
  return {
    name: 'llull-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const policy = parseServiceWorkerPolicy(
        JSON.parse(readFileSync(resolve(root, 'serviceWorker/config.json'), 'utf8')),
      );
      const sourceOf = (fileName: string): string | Uint8Array => {
        const output = bundle[fileName];
        if (output === undefined) return '';
        return output.type === 'chunk' ? output.code : output.source;
      };
      const files = Object.keys(bundle).map((fileName) => ({
        fileName,
        bytes: Buffer.byteLength(sourceOf(fileName)),
      }));
      const workerSource = readFileSync(resolve(root, 'serviceWorker/sw.js'), 'utf8');
      const manifest = buildServiceWorkerManifest(
        files,
        policy,
        (fileName) => createHash('sha256').update(sourceOf(fileName)).digest('hex'),
        workerSource,
      );
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerScript(manifest, workerSource),
      });
    },
  };
}
