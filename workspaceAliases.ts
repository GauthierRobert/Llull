/**
 * Vite / Vitest `resolve.alias` derived from `tsconfig.base.json` — the single source of the
 * workspace path aliases (`@core/*`, `@aec/*`, …) for tsc, Vite, Vitest, esbuild and tsx.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export function workspaceAliases(): Record<string, string> {
  const base = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, [string]> };
  };
  return Object.fromEntries(
    Object.entries(base.compilerOptions.paths).map(([pattern, [target]]) => [
      pattern.replace(/\/\*$/, ''),
      resolve(root, target.replace(/\/\*$/, '')),
    ]),
  );
}
