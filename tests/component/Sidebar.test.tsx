/**
 * Component tests for <Sidebar /> (icon rail + document browser panel).
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - The rail lists every browser panel as a tab.
 *   - Selecting a tab shows that panel; re-selecting the open tab collapses the sidebar.
 *   - Rail badges reflect document counts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useLayoutStore, useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { Sidebar } from '@ui/components/Sidebar';

const TAB_LABELS = [
  'Layers',
  'Assembly',
  'Mechanisms',
  'Parameters',
  'History',
  'Configurations',
  'Materials',
];

describe('Sidebar', () => {
  beforeEach(() => {
    __resetIdCounter();
    useStore.setState({ document: createEmptyDocument(), lastSummary: null });
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true });
  });

  it('renders one rail tab per browser panel', () => {
    render(<Sidebar />);
    for (const label of TAB_LABELS) {
      expect(screen.getByRole('tab', { name: label })).toBeDefined();
    }
  });

  it('shows the Layers panel by default', () => {
    render(<Sidebar />);
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toBeDefined();
    expect(screen.getByLabelText('Layer list')).toBeDefined();
  });

  it('switches panel when another tab is selected', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('tab', { name: 'Parameters' }));
    expect(useLayoutStore.getState().sidebarTab).toBe('parameters');
    expect(screen.getByRole('tab', { name: 'Parameters' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByLabelText('Layer list')).toBeNull();
  });

  it('collapses when the open tab is selected again', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('shows a count badge from the document', () => {
    render(<Sidebar />);
    // Empty document has the default layer.
    expect(screen.getByRole('tab', { name: 'Layers' }).textContent).toContain('1');
  });
});
