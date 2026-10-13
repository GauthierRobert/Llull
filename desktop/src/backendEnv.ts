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
}

/** Big documents are opened with one `load_document` call; the server default is 2 MB. */
const DESKTOP_BODY_LIMIT = '512mb';

export function backendOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function backendEnv(input: BackendEnvInput): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(input.baseEnv).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('LLULL_') && entry[0] !== 'MCP_AUTH_TOKEN',
    ),
  );
  return {
    ...inherited,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(input.port),
    MCP_AUTH_TOKEN: input.token,
    LLULL_REQUIRE_TOKEN_FOR_REST: 'true',
    LLULL_ALLOWED_ORIGINS: backendOrigin(input.port),
    LLULL_STATIC_DIR: input.layout.webDir,
    LLULL_AUTOSAVE_PATH: path.join(input.userDataDir, 'autosave.json'),
    LLULL_BODY_LIMIT: DESKTOP_BODY_LIMIT,
    LLULL_PYTHON: input.layout.python,
    // import_code runs arbitrary Python: off unless the user launched the app with it set to 1.
    ...(input.baseEnv['LLULL_ALLOW_CODE_EXECUTION'] === '1' ? { LLULL_ALLOW_CODE_EXECUTION: '1' } : {}),
  };
}
