/**
 * The environment the desktop app gives its local backend (server/dist/index.js). The backend is
 * the unchanged llull server: same routes, same command bus. Hardening for a single-user desktop:
 * loopback only, a per-launch token required on every REST call (other local processes and
 * websites cannot drive the document), and the app's own origin as the only browser origin.
 */

import path from 'path';
import type { DesktopLayout } from './layout';

interface BackendEnvInput {
  readonly port: number;
  readonly token: string;
  readonly layout: DesktopLayout;
  /** Electron `app.getPath('userData')`: autosave + audit live here. */
  readonly userDataDir: string;
  /** Inherited environment (PATH, HOME, locale, …). */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** The native binaries bundle when it is present (`nativeBundleDir`), else null: the backend then uses its TypeScript paths. */
  readonly nativeDir?: string | null;
  /** The bundle holds `llull-kernel` (`hasNativeKernel`): the default kernel is then the native OCCT 7.9 sidecar (KI7). */
  readonly nativeKernel?: boolean;
}

const NATIVE_BINARIES = ['llull-compute', 'llull-kernel'] as const;

/** `dir` when it holds at least one native binary (RS1; desktop/scripts/prepare-native.mjs), else null. */
export function nativeBundleDir(dir: string, platform: NodeJS.Platform, exists: (file: string) => boolean): string | null {
  const suffix = platform === 'win32' ? '.exe' : '';
  return NATIVE_BINARIES.some((binary) => exists(path.join(dir, `${binary}${suffix}`))) ? dir : null;
}

/** True when `dir` holds the native kernel binary `llull-kernel` (a bundle may ship `llull-compute` only: LLULL_NATIVE_KERNEL=0). */
export function hasNativeKernel(dir: string | null, platform: NodeJS.Platform, exists: (file: string) => boolean): boolean {
  return dir !== null && exists(path.join(dir, platform === 'win32' ? 'llull-kernel.exe' : 'llull-kernel'));
}

/**
 * The backend's kernel (TR-KRN-01, KI7): the native OCCT 7.9 sidecar when bundled, else the WASM OCC kernel. An inherited
 * LLULL_KERNEL=manifold or occt (the WASM kernel) is a diagnostic override; any other inherited value is ignored.
 */
export function desktopKernel(inherited: string | undefined, nativeKernel: boolean): 'manifold' | 'occt' | 'occt-native' {
  if (inherited === 'manifold' || inherited === 'occt') return inherited;
  return nativeKernel ? 'occt-native' : 'occt';
}

/** Big documents are opened with one `load_document` call; the server default is 2 MB. */
const DESKTOP_BODY_LIMIT = '512mb';

export function backendOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function backendEnv(input: BackendEnvInput): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(input.baseEnv).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('LLULL_') && entry[0] !== 'LLULL_AUTH_TOKEN',
    ),
  );
  return {
    ...inherited,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(input.port),
    LLULL_AUTH_TOKEN: input.token,
    LLULL_REQUIRE_TOKEN_FOR_REST: 'true',
    LLULL_ALLOWED_ORIGINS: backendOrigin(input.port),
    LLULL_STATIC_DIR: input.layout.webDir,
    LLULL_AUTOSAVE_PATH: path.join(input.userDataDir, 'autosave.json'),
    LLULL_BODY_LIMIT: DESKTOP_BODY_LIMIT,
    LLULL_PYTHON: input.layout.python,
    // Native compute jobs and the native kernel binary, only when bundled.
    ...(input.nativeDir === undefined || input.nativeDir === null ? {} : { LLULL_NATIVE_DIR: input.nativeDir }),
    // An exact OCC kernel is the desktop default (TR-KRN-01): native when bundled (VC-KRN-25 passed, KI7), else WASM.
    LLULL_KERNEL: desktopKernel(
      input.baseEnv['LLULL_KERNEL'],
      input.nativeDir !== undefined && input.nativeDir !== null && input.nativeKernel === true,
    ),
    // import_code runs arbitrary Python: off unless the user launched the app with it set to 1.
    ...(input.baseEnv['LLULL_ALLOW_CODE_EXECUTION'] === '1' ? { LLULL_ALLOW_CODE_EXECUTION: '1' } : {}),
  };
}
