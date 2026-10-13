/**
 * Where the desktop app finds its parts: the built web app, the server bundle, the CLI bundle and
 * the bundled Python. Packaged: under `process.resourcesPath` (electron-builder `extraResources`).
 * Development (`npm start`): the repo checkout.
 */

import path from 'path';

export interface DesktopLayout {
  /** Built web app (Vite `dist/`, built with VITE_LLULL_SERVER_URL=same-origin). */
  readonly webDir: string;
  /** Server bundle entry (`server/dist/index.js`). */
  readonly serverEntry: string;
  /** CLI bundle entry (`server/dist/cli.js`; next to index.js so it finds ../python like the server). */
  readonly cliEntry: string;
  /** Python interpreter with CadQuery (bundled), or the dev fallback. */
  readonly python: string;
}

interface LayoutInput {
  readonly packaged: boolean;
  /** `process.resourcesPath` (packaged) — ignored in development. */
  readonly resourcesPath: string;
  /** Repo root (development) — ignored when packaged. */
  readonly repoRoot: string;
  readonly platform: NodeJS.Platform;
  /** Development only: `$LLULL_PYTHON` override. */
  readonly pythonOverride?: string | undefined;
}

/** The interpreter inside a python-build-standalone tree (`install_only` layout). */
export function bundledPythonOf(pythonRoot: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3');
}

export function desktopLayout(input: LayoutInput): DesktopLayout {
  if (input.packaged) {
    const resources = input.resourcesPath;
    return {
      webDir: path.join(resources, 'web'),
      serverEntry: path.join(resources, 'server', 'dist', 'index.js'),
      cliEntry: path.join(resources, 'server', 'dist', 'cli.js'),
      python: bundledPythonOf(path.join(resources, 'python'), input.platform),
    };
  }
  const root = input.repoRoot;
  return {
    webDir: path.join(root, 'dist'),
    serverEntry: path.join(root, 'server', 'dist', 'index.js'),
    cliEntry: path.join(root, 'server', 'dist', 'cli.js'),
    python: input.pythonOverride ?? bundledPythonOf(path.join(root, 'desktop', 'build', 'python'), input.platform),
  };
}
