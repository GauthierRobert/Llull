/**
 * @layer ui/services
 *
 * The ONE owner of the service worker (serviceWorker/sw.js): registration, periodic update
 * checks, "a new version is waiting" state, and applying it. Components read the state through
 * `useAppUpdateAvailable()` and call `applyAppUpdate()` — nothing else touches
 * `navigator.serviceWorker`. A new version never takes over on its own: the user chooses when
 * to reload, so an in-progress drawing is not interrupted.
 */

import { useSyncExternalStore } from 'react';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SKIP_WAITING = 'SKIP_WAITING';

let waitingWorker: ServiceWorker | null = null;
const listeners = new Set<() => void>();

function setWaitingWorker(worker: ServiceWorker | null): void {
  if (worker === waitingWorker) return;
  waitingWorker = worker;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isUpdateAvailable = (): boolean => waitingWorker !== null;

/** True while a newer build is installed and waiting for `applyAppUpdate()`. */
export function useAppUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribe, isUpdateAvailable, () => false);
}

/** A worker that finished installing while another one controls the page is an update. */
function watchInstalling(registration: ServiceWorkerRegistration, container: ServiceWorkerContainer): void {
  const worker = registration.installing;
  if (worker === null) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && container.controller !== null) {
      setWaitingWorker(registration.waiting ?? worker);
    }
  });
}

/**
 * Registers `/sw.js` and starts hourly update checks. No-op without service-worker support.
 * @returns stops the update checks (the registration itself stays).
 */
export async function registerAppServiceWorker(
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
  reload: () => void = () => window.location.reload(),
): Promise<() => void> {
  if (container === undefined) return () => undefined;
  let reloading = false;
  container.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    reload();
  });
  const registration = await container.register('/sw.js', { scope: '/' });
  if (registration.waiting !== null && container.controller !== null) {
    setWaitingWorker(registration.waiting);
  }
  registration.addEventListener('updatefound', () => watchInstalling(registration, container));
  const timer = setInterval(() => {
    registration.update().catch(() => undefined);
  }, UPDATE_CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Activates the waiting build; the `controllerchange` it triggers reloads the page once. */
export function applyAppUpdate(): void {
  waitingWorker?.postMessage(SKIP_WAITING);
}
