/**
 * Auth of a standalone backend launch (`node dist/index.js`, `npm run dev`): a launch with no `LLULL_AUTH_TOKEN` and no explicit
 * `--insecure-no-token` generates a per-launch token the way the desktop app does, and hands it to its own client by printing it
 * (`llull --server URL --token T`). The desktop always sets its own token, so it never reaches this path.
 */
import { randomBytes } from 'node:crypto';

const INSECURE_FLAG = '--insecure-no-token';

export type LaunchAuth =
  | { readonly mode: 'configured' }
  | { readonly mode: 'insecure' }
  | { readonly mode: 'generated'; readonly token: string };

/** Resolve the launch's auth mode and write it to `env` (LLULL_AUTH_TOKEN / LLULL_INSECURE_NO_TOKEN), which `security.ts` reads per request. */
export function applyLaunchAuth(env: NodeJS.ProcessEnv, argv: readonly string[]): LaunchAuth {
  if (argv.includes(INSECURE_FLAG)) env['LLULL_INSECURE_NO_TOKEN'] = '1';
  const configured = env['LLULL_AUTH_TOKEN'];
  if (configured !== undefined && configured !== '') return { mode: 'configured' };
  if (env['LLULL_INSECURE_NO_TOKEN'] === '1') return { mode: 'insecure' };
  const token = randomBytes(24).toString('hex');
  env['LLULL_AUTH_TOKEN'] = token;
  return { mode: 'generated', token };
}

/** The line the launch prints so its client can authenticate (null when the token was configured by the caller). */
export function launchAuthNotice(auth: LaunchAuth, url: string): string | null {
  if (auth.mode === 'configured') return null;
  if (auth.mode === 'insecure') return `[llull-server] WARNING: ${INSECURE_FLAG}: mutating routes are open to any local process.`;
  return `[llull-server] per-launch auth token (generated): ${auth.token}\n[llull-server] llull --server ${url} --token ${auth.token}   (or LLULL_TOKEN)`;
}
