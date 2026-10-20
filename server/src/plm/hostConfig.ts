/**
 * The fixed locations and switches of the PLM host (09 PLM TR-PLM-19). Production reads NO environment variable for trust, test keys or the audit
 * log: an agent that controls the environment of a CLI process must not be able to move the trust store, accept the published RFC 8032 keys or turn the
 * audit off. The only way to change any of this is `configureHostForTests`, called by test code in the same process.
 */

import { userInfo } from 'node:os';
import path from 'node:path';

export interface HostOverrides {
  /** Trust store directory (default: ~/.llull/trust). */
  readonly trustDir?: string;
  /** Audit directory (default ~/.llull/audit); `null` disables the log (test suites that do not care). */
  readonly auditDir?: string | null;
  /** Trust the three published RFC 8032 test keys. */
  readonly acceptTestKeys?: boolean;
}

/** The account's home from the OS user database, NOT `os.homedir()` (which honours HOME / USERPROFILE, i.e. the agent-controlled environment). */
export const accountHome = (): string => userInfo().homedir;

let overrides: HostOverrides = {};

/** Tests only: replace the overrides (`{}` restores the production locations). */
export function configureHostForTests(next: HostOverrides): void {
  overrides = next;
}

export const trustDirectory = (): string => overrides.trustDir ?? path.join(accountHome(), '.llull', 'trust');
export const auditDirectory = (): string | null =>
  overrides.auditDir === undefined ? path.join(accountHome(), '.llull', 'audit') : overrides.auditDir;
export const acceptsTestKeys = (): boolean => overrides.acceptTestKeys === true;
