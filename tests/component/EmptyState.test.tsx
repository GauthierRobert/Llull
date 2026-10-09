/**
 * Component tests for <EmptyState /> — the "start your model" card.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Shown when document.order is empty; absent once any entity exists or a 2D tool is armed.
 *   - "Add a 3D box" creates a selected box; "Draw a 2D rectangle" arms the rectangle tool.
 *   - "Civil site starter" loads the sample survey and builds the whole site in one plan.
 *   - Dismiss hides the card without changing the document.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useLayoutStore, useStore, useToolStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { EmptyState } from '@ui/components/EmptyState';
import { localDispatch } from '../helpers/storeTestHelpers';

function resetStores(): void {
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ liveStatus: 'disconnected', lastSummary: null });
  useToolStore.setState({ viewMode: '3d', drawTool: 'none', gizmoMode: 'translate' });
}

const card = (): HTMLElement | null => screen.queryByRole('region', { name: /get started/i });

describe('EmptyState — visibility', () => {
  beforeEach(() => {
    resetStores();
  });

  it('renders the start card when the document has 0 entities', () => {
    render(<EmptyState />);
    expect(card()).not.toBeNull();
    expect(screen.getByText(/start your model/i)).toBeDefined();
  });

  it('does NOT render when the document has an entity', () => {
    localDispatch('add_box', { size: [2, 2, 2] });
    render(<EmptyState />);
    expect(card()).toBeNull();
  });

  it('does NOT render while a 2D draw tool is armed', () => {
    useToolStore.getState().setDrawTool('line');
    render(<EmptyState />);
    expect(card()).toBeNull();
  });
});

describe('EmptyState — quick starts', () => {
  beforeEach(() => {
    resetStores();
  });

  it('"Add a 3D box" creates a box, selects it and shows the 3D view', () => {
    useToolStore.setState({ viewMode: '2d' });
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /add a 3d box/i }));
    const { document } = useStore.getState();
    expect(document.order).toHaveLength(1);
    expect(document.entities[document.order[0]!]?.kind).toBe('box');
    expect(document.selection).toEqual(document.order);
    expect(useToolStore.getState().viewMode).toBe('3d');
  });

  it('"Draw a 2D rectangle" arms the rectangle tool in the 2D view', () => {
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /draw a 2d rectangle/i }));
    expect(useToolStore.getState().drawTool).toBe('rectangle');
    expect(useToolStore.getState().viewMode).toBe('2d');
    expect(useStore.getState().document.order).toHaveLength(0);
  });

  it('explains how to move things and how to connect an agent', () => {
    render(<EmptyState />);
    expect(screen.getByText(/move things:/i)).toBeDefined();
    expect(screen.getByText(/let ai build it/i)).toBeDefined();
  });
});

describe('EmptyState — civil site starter', () => {
  beforeEach(() => {
    resetStores();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const civilCounts = (): Record<string, number> => {
    const civil = useStore.getState().document.civil;
    const counts: Record<string, number> = {};
    for (const id of civil?.order ?? []) {
      const category = civil?.objects[id]?.category ?? '?';
      counts[category] = (counts[category] ?? 0) + 1;
    }
    return counts;
  };

  it('fetches the sample survey and builds survey, terrain, pad, road and a sized storm network', async () => {
    const csv = readFileSync('public/samples/pilot-site-survey.csv', 'utf8');
    const fetchMock = vi.fn(() => Promise.resolve(new Response(csv, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /civil site starter/i }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/samples\/pilot-site-survey\.csv$/));
    expect(useLayoutStore.getState().sidebarTab).toBe('civil');
    await waitFor(() => expect(civilCounts()['pipe']).toBe(3));
    expect(civilCounts()).toEqual({
      pointGroup: 1,
      surface: 1,
      platform: 1,
      alignment: 1,
      manhole: 4,
      pipe: 3,
    });
    expect(useStore.getState().document.units).toBe('m');
    expect(useStore.getState().lastSummary).toMatch(/Plan complete/);
  });

  it('reports a survey that cannot be loaded and leaves the document unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('missing', { status: 404 }))),
    );
    const before = useStore.getState().document;
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /civil site starter/i }));
    await waitFor(() =>
      expect(useStore.getState().lastSummary).toMatch(/could not load the sample survey \(HTTP 404\)/),
    );
    expect(useStore.getState().document).toBe(before);
  });
});

describe('EmptyState — dismiss', () => {
  beforeEach(() => {
    resetStores();
  });

  it('hides the card without changing the document (PRIME DIRECTIVE)', () => {
    const before = useStore.getState().document;
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(card()).toBeNull();
    expect(useStore.getState().document).toBe(before);
  });
});
