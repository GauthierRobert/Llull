/**
 * Navigation policy for the app window: only the local backend's own origin loads in the window;
 * other http(s) links open in the system browser; everything else is denied. Compares parsed
 * origins — a prefix test would let `http://127.0.0.1:47827@evil.example/` through.
 */

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export type NavigationDecision = 'app' | 'external' | 'deny';

export function navigationDecision(target: string, appOrigin: string): NavigationDecision {
  const origin = originOf(target);
  if (origin === null) return 'deny';
  if (origin === appOrigin) return 'app';
  return /^https?:$/i.test(new URL(target).protocol) ? 'external' : 'deny';
}

/**
 * Web permissions (camera, geolocation, notifications, ...) the app window may receive. llull
 * needs none beyond writing to the clipboard; everything else is denied instead of Electron's
 * grant-all default.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

export function permissionAllowed(permission: string, requestingUrl: string, appOrigin: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && originOf(requestingUrl) === appOrigin;
}
