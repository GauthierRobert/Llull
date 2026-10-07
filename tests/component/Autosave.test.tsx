/**
 * Tests for the autosave storage adapter, the debounced save, the startup restore through
 * `load_document`, the restore banner, and unsaved-changes tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';
import {
  AUTOSAVE_KEY,
  clearAutosave,
  readAutosave,
  writeAutosave,
  type KeyValueStorage,
} from '@ui/store/autosave';
import { AUTOSAVE_DELAY_MS, useAutosave } from '@ui/hooks/useAutosave';
import { RestoredBanner } from '@ui/components/RestoredBanner';

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe('autosave storage adapter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a record', () => {
    const storage = fakeStorage();
    expect(writeAutosave(storage, { savedAt: 5, json: '{}' })).toBe(true);
    expect(readAutosave(storage)).toEqual({ savedAt: 5, json: '{}' });
    clearAutosave(storage);
    expect(readAutosave(storage)).toBeNull();
  });

  it('never throws when storage is full or broken', () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(writeAutosave(broken, { savedAt: 1, json: '{}' })).toBe(false);
    expect(readAutosave(broken)).toBeNull();
    expect(() => clearAutosave(broken)).not.toThrow();
  });

  it('ignores and clears a corrupted record', () => {
    const storage = fakeStorage({ [AUTOSAVE_KEY]: '{not json' });
    expect(readAutosave(storage)).toBeNull();
    expect(storage.data[AUTOSAVE_KEY]).toBeUndefined();
    const wrongShape = fakeStorage({ [AUTOSAVE_KEY]: '{"savedAt":"x"}' });
    expect(readAutosave(wrongShape)).toBeNull();
    expect(wrongShape.data[AUTOSAVE_KEY]).toBeUndefined();
  });
});

function Harness({ storage }: { storage: KeyValueStorage }): React.ReactElement {
  useAutosave(storage);
  return <RestoredBanner />;
}

function savedBoxJson(): string {
  return serializeDocument(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document);
}

describe('useAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected', lastSummary: null });
    useSessionStore.setState({ dirty: false, restoredAt: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('saves the document after the debounce and marks it unsaved', () => {
    const storage = fakeStorage();
    render(<Harness storage={storage} />);
    act(() => useStore.getState().dispatch('add_box', { size: [1, 1, 1] }));
    expect(useSessionStore.getState().dirty).toBe(true);
    expect(storage.data[AUTOSAVE_KEY]).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 10);
    });
    expect(readAutosave(storage)?.json).toContain('box');
  });

  it('restores an autosaved document through load_document and shows the banner', () => {
    const storage = fakeStorage();
    writeAutosave(storage, { savedAt: Date.now(), json: savedBoxJson() });
    render(<Harness storage={storage} />);
    expect(useStore.getState().document.order.length).toBe(1);
    expect(screen.getByText(/restored your unsaved work/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /start fresh/i }));
    expect(useStore.getState().document.order.length).toBe(0);
    expect(screen.queryByText(/restored your unsaved work/i)).toBeNull();
  });

  it('does not restore when a live server is connected', () => {
    useStore.setState({ liveStatus: 'connected' });
    const storage = fakeStorage();
    writeAutosave(storage, { savedAt: 1, json: savedBoxJson() });
    render(<Harness storage={storage} />);
    expect(useStore.getState().document.order.length).toBe(0);
  });

  it('waits for the connection attempt, then restores when it fails', () => {
    useStore.setState({ liveStatus: 'connecting' });
    const storage = fakeStorage();
    writeAutosave(storage, { savedAt: 1, json: savedBoxJson() });
    render(<Harness storage={storage} />);
    expect(useStore.getState().document.order.length).toBe(0);
    act(() => useStore.getState().setLiveStatus('disconnected'));
    expect(useStore.getState().document.order.length).toBe(1);
  });

  it('discards an autosave that cannot be loaded', () => {
    const storage = fakeStorage();
    writeAutosave(storage, { savedAt: 1, json: 'not a document' });
    render(<Harness storage={storage} />);
    expect(useStore.getState().document.order.length).toBe(0);
    expect(storage.data[AUTOSAVE_KEY]).toBeUndefined();
  });
});
