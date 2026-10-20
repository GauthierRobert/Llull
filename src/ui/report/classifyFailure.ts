/**
 * Which command outcomes deserve a bug report (SC-A4). The UI sees only the summary text (`onResult`), so this reads the stable shapes
 * the registry produces: a run that threw ("<name> failed: …; document unchanged." from the guard, "Command <name> failed: …" from the
 * backend, an HTTP 5xx) or a kernel failure (OCCT threw / panicked) is INTERNAL; a native "not supported" is a notice; every other
 * refusal (invalid params, guards, a command's own no-op) is the user's input and is never offered as a bug.
 */

export type FailureKind = 'internal' | 'unsupported' | 'user';

const KERNEL_FAILURE = /\b(?:NATIVE_)?(?:OCC_FAILURE|PANIC)\b/;
const NATIVE_UNSUPPORTED = /\bNATIVE_UNSUPPORTED\b/;
const THREW_IN_GUARD = /^\S+ failed: .*; document unchanged\.?/s;
const THREW_ON_SERVER = /^Command \S+ failed: /;
const SERVER_ERROR = /^Server responded with HTTP 5\d\d\b/;

export function classifyFailure(summary: string): FailureKind {
  if (NATIVE_UNSUPPORTED.test(summary)) return 'unsupported';
  if (KERNEL_FAILURE.test(summary) || THREW_ON_SERVER.test(summary) || THREW_IN_GUARD.test(summary) || SERVER_ERROR.test(summary)) {
    return 'internal';
  }
  return 'user';
}
