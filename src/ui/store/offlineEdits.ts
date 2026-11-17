// FR-DSF-23: edits made while the backend was unreachable are NEVER discarded when it comes back. Before the backend's document replaces the
// local one, the local document is kept as a recoverable copy: a recovery slot in the backend (durable, listed by Document Recovery) and,
// when the backend cannot take it, the device's autosave record offered by RestoredBanner.

import { serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { browserStorage, clearAutosave, writeAutosave } from './autosave';
import { useRecoveryStore } from './recoveryStore';
import { postRecovery } from './serverCommands';
import { useSessionStore } from './sessionStore';

export function preserveOfflineEdits(offlineDocument: CadDocument, changeCount: number): void {
  const json = serializeDocument(offlineDocument);
  void postRecovery('offline', { json, changeCount, path: useRecoveryStore.getState().documentPath }).then(
    () => {
      // the backend slot is now the recoverable copy: drop the device copy so the same work is not offered twice at next launch
      const storage = browserStorage();
      if (storage !== null) clearAutosave(storage);
      useRecoveryStore.getState().setOfflineEditsKept(true);
      void useRecoveryStore.getState().refresh(false);
    },
    () => {
      const savedAt = Date.now();
      const storage = browserStorage();
      if (storage !== null) writeAutosave(storage, { savedAt, json });
      useSessionStore.getState().setPendingLocalCopy({ savedAt, json });
    },
  );
}
