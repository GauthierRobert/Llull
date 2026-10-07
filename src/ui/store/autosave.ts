/**
 * @layer ui/store
 *
 * Autosave storage adapter: persists the serialized working document (same format as Save) to a
 * key/value storage. Never throws — quota or corruption problems are warned about and dropped.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AutosaveRecord {
  /** Epoch ms of the save. */
  savedAt: number;
  /** `serializeDocument` output. */
  json: string;
}

export const AUTOSAVE_KEY = 'llull-autosave';

export function writeAutosave(storage: KeyValueStorage, record: AutosaveRecord): boolean {
  try {
    storage.setItem(AUTOSAVE_KEY, JSON.stringify(record));
    return true;
  } catch (err) {
    console.warn('llull: autosave failed (storage full or unavailable)', err);
    return false;
  }
}

export function clearAutosave(storage: KeyValueStorage): void {
  try {
    storage.removeItem(AUTOSAVE_KEY);
  } catch (err) {
    console.warn('llull: could not clear autosave', err);
  }
}

/** The stored record, or null when absent. A corrupted record is cleared and ignored. */
export function readAutosave(storage: KeyValueStorage): AutosaveRecord | null {
  let raw: string | null;
  try {
    raw = storage.getItem(AUTOSAVE_KEY);
  } catch (err) {
    console.warn('llull: autosave unreadable', err);
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'savedAt' in parsed &&
      'json' in parsed &&
      typeof parsed.savedAt === 'number' &&
      typeof parsed.json === 'string'
    ) {
      return { savedAt: parsed.savedAt, json: parsed.json };
    }
  } catch {
    // fall through to clearing
  }
  console.warn('llull: corrupted autosave ignored and cleared');
  clearAutosave(storage);
  return null;
}

/** The browser's localStorage, or null when unavailable (private mode, SSR, blocked storage). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
