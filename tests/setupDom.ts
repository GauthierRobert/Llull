import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

/**
 * The `dom` project shares one module graph per worker (isolate: false), like `node`: every test starts from the state a fresh
 * import would give. Testing Library's auto-cleanup registers in the first file only, so renders are unmounted here; every zustand
 * store of the UI (STORE_MODULES, kept complete by tests/unit/contract/isolatedSuites.test.ts) is put back to its initial state.
 */
const STORE_MODULES = import.meta.glob<Record<string, unknown>>(
  ['/src/ui/**/*Store.ts', '/src/ui/store/store.ts', '/src/ui/store/kernelStatus.ts'],
  { eager: true },
);

interface ResettableStore {
  getInitialState(): unknown;
  setState(state: unknown, replace: true): void;
}

const isStore = (value: unknown): value is ResettableStore =>
  typeof value === 'function' &&
  typeof (value as Partial<ResettableStore>).getInitialState === 'function' &&
  typeof (value as Partial<ResettableStore>).setState === 'function';

const stores = Object.values(STORE_MODULES).flatMap((exports) => Object.values(exports).filter(isStore));

beforeEach(() => {
  for (const store of stores) store.setState(store.getInitialState(), true);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);
