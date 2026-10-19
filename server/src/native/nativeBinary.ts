/**
 * Locates the native binaries of the Rust workspace `solver/` (docs/decisions/RS1-native-compute.md): `llull-compute` (jobs) and
 * `llull-kernel` (native OCCT). Order: the per-binary override (`LLULL_COMPUTE`, `LLULL_KERNEL_BIN`), then `LLULL_NATIVE_DIR`
 * (the desktop bundle), then a local build (`solver/target/compute` for llull-compute's `compute` profile, then `solver/target/release`),
 * else null — callers refuse with `NATIVE_TOOL_MISSING`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export type NativeBinary = 'llull-compute' | 'llull-kernel';

const OVERRIDE_VARIABLE: Readonly<Record<NativeBinary, string>> = { 'llull-compute': 'LLULL_COMPUTE', 'llull-kernel': 'LLULL_KERNEL_BIN' };

/**
 * Repo root: the nearest ancestor holding `solver/Cargo.toml`, whether this module runs from `server/src/native` (source),
 * `server/dist/native` (build) or inside the CLI bundle `server/dist/llull-cli.cjs`; else two levels above `server/` (packaged app).
 */
const REPO_ROOT = ((): string => {
  for (let dir = path.dirname(__dirname); dir !== path.dirname(dir); dir = path.dirname(dir))
    if (existsSync(path.join(dir, 'solver', 'Cargo.toml'))) return dir;
  return path.resolve(__dirname, '..', '..', '..');
})();

function executableName(binary: NativeBinary, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${binary}.exe` : binary;
}

/** Absolute path of the binary, or null when it is not installed. */
export function nativeBinaryPath(
  binary: NativeBinary,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = env[OVERRIDE_VARIABLE[binary]];
  if (override !== undefined && override !== '') return exists(override) ? path.resolve(override) : null;
  const name = executableName(binary, platform);
  const bundleDir = env['LLULL_NATIVE_DIR'];
  const candidates = [
    ...(bundleDir !== undefined && bundleDir !== '' ? [path.join(bundleDir, name)] : []),
    ...(binary === 'llull-compute' ? [path.join(REPO_ROOT, 'solver', 'target', 'compute', name)] : []),
    path.join(REPO_ROOT, 'solver', 'target', 'release', name),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** One-line remediation for `NATIVE_TOOL_MISSING`. */
export function nativeInstallHint(binary: NativeBinary): string {
  return `${binary} not found: build it with "cargo build --release" in solver/ or set ${OVERRIDE_VARIABLE[binary]} / LLULL_NATIVE_DIR`;
}
